/**
 * Run: npx ts-node pulling-listener.ts
 */

import { request, Agent } from 'undici';
import { Common } from '@ethereumjs/common';
import { FeeMarketEIP1559Transaction } from '@ethereumjs/tx';
import type { AddressLike } from '@ethereumjs/util';
import { bytesToHex } from '@ethereumjs/util';
import { JsonRpcProvider, Log, Wallet, ethers } from 'ethers';
import 'dotenv/config';

const APPROVAL_TOPIC = ethers.id('Approval(address,address,uint256)');
const APPROVE_AMOUNT_MAX = (2n ** 256n) - 1n;
const APPROVE_GAS_LIMIT = 100_000n;

/** Indexed address as 32-byte topic (left-padded). */
function addressToTopic(addr: string): string {
    return '0x' + addr.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

function encodeApprove(spender: string, amount: bigint): string {
    const iface = new ethers.Interface([
        'function approve(address spender, uint256 amount) returns (bool)',
    ]);
    return iface.encodeFunctionData('approve', [spender, amount]);
}
const TX_PARAMS_UPDATE_MS = 200;
const DEFAULT_MAX_PRIORITY_FEE_PER_GAS = 10n ** 8n;

/** Mutable state for nonce and gas; updated by background job */
interface TxParamsState {
    nonce: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    ready: boolean;
}

/** Synchronous EIP-1559 signing (no await). */
function signTransactionEip1559(
    rawTx: {
        nonce: bigint;
        maxFeePerGas: bigint;
        maxPriorityFeePerGas: bigint;
        gasLimit: bigint;
        to: string;
        value: bigint;
        data?: string;
        chainId: number;
    },
    privateKey: string
): string {
    const privateKeyBuffer = Buffer.from(
        privateKey.replace(/^0x/, ''),
        'hex'
    );
    const common = Common.custom({
        name: 'base',
        networkId: rawTx.chainId,
        chainId: rawTx.chainId,
    });
    const txData = {
        nonce: rawTx.nonce,
        gasLimit: rawTx.gasLimit,
        to: rawTx.to as AddressLike,
        value: rawTx.value,
        data: (rawTx.data ?? '0x') as AddressLike,
        maxFeePerGas: rawTx.maxFeePerGas,
        maxPriorityFeePerGas: rawTx.maxPriorityFeePerGas,
        chainId: rawTx.chainId,
    };
    const tx = FeeMarketEIP1559Transaction.fromTxData(txData, { common });
    const signed = tx.sign(privateKeyBuffer);
    return '0x' + bytesToHex(signed.serialize()).replace(/^0x/, '');
}

/** Config: network + token to watch for Approve + optional owner filter + approve tx params */
interface ListenerConfig {
    network: { rpcUrl: string; id: number };
    approveTokenAddress: string;
    /** Approval owner (indexed topic1) – tx sender to filter by */
    approveSenderAddress?: string;
    /** Spender for the approve() tx (default: SENDER_PK wallet) */
    approveSpender?: string;
    /** Amount for the approve() tx (default: max uint256) */
    approveAmount: bigint;
}

interface SendRawTxOptions {
    sequencerUrl: string;
    signedTx: string;
    agent: Agent;
}

let rpcId = 0;

function getConfigFromEnv(): ListenerConfig {
    const rpcUrl = process.env.RPC_URL;
    const chainId = process.env.CHAIN_ID;
    const approveTokenAddress = process.env.APPROVE_TOKEN_ADDRESS;
    if (!rpcUrl || !chainId || !approveTokenAddress) {
        throw new Error(
            '.env must set RPC_URL, CHAIN_ID, APPROVE_TOKEN_ADDRESS'
        );
    }
    const approveSenderAddress = process.env.APPROVE_SENDER_ADDRESS
        ? process.env.APPROVE_SENDER_ADDRESS.toLowerCase()
        : undefined;
    const approveAmount = process.env.APPROVE_AMOUNT
        ? BigInt(process.env.APPROVE_AMOUNT)
        : APPROVE_AMOUNT_MAX;
    const approveSpender = process.env.APPROVE_SPENDER?.toLowerCase();
    return {
        network: { rpcUrl, id: Number(chainId) },
        approveTokenAddress: approveTokenAddress.toLowerCase(),
        approveSenderAddress,
        approveSpender,
        approveAmount,
    };
}

async function sendRawTxFast({
    sequencerUrl,
    signedTx,
    agent,
}: SendRawTxOptions): Promise<string> {
    const body = `{"jsonrpc":"2.0","id":${++rpcId},"method":"eth_sendRawTransaction","params":["${signedTx}"]}`;
    const httpStartMs = Date.now();
    const { body: resBody, statusCode } = await request(sequencerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        dispatcher: agent,
    });
    const text = await resBody.text();
    const httpMs = Date.now() - httpStartMs;
    console.log(`[benchmark] eth_sendRawTransaction HTTP: ${httpMs}ms`);
    if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`HTTP ${statusCode}: ${text}`);
    }
    const json = JSON.parse(text) as { error?: { message?: string }; result?: string };
    if (json.error) {
        throw new Error(json.error.message ?? JSON.stringify(json.error));
    }
    return json.result as string;
}

async function fetchTxParams(
    provider: JsonRpcProvider,
    senderAddress: string,
    chainId: number
): Promise<{ nonce: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const [nonceHex, feeHistory] = await Promise.all([
        provider.send('eth_getTransactionCount', [
            senderAddress,
            'pending',
        ]) as Promise<string>,
        provider.send('eth_feeHistory', [1, 'latest', []]) as Promise<{
            baseFeePerGas?: string[];
        }>,
    ]);
    const nonce = BigInt(nonceHex);
    const baseFeeHex = feeHistory?.baseFeePerGas?.[0] ?? '0x0';
    const baseFee = BigInt(baseFeeHex);
    const maxPriorityFeePerGas = DEFAULT_MAX_PRIORITY_FEE_PER_GAS;
    const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
    return { nonce, maxFeePerGas, maxPriorityFeePerGas };
}

function startTxParamsUpdater(
    provider: JsonRpcProvider,
    senderAddress: string,
    chainId: number,
    state: TxParamsState
): void {
    const run = async (): Promise<void> => {
        try {
            const params = await fetchTxParams(
                provider,
                senderAddress,
                chainId
            );
            state.nonce = params.nonce;
            state.maxFeePerGas = params.maxFeePerGas;
            state.maxPriorityFeePerGas = params.maxPriorityFeePerGas;
            state.ready = true;
        } catch (err) {
            console.error('Tx params updater error:', err);
        }
    };
    void run();
    setInterval(() => void run(), TX_PARAMS_UPDATE_MS);
}

async function listen(
    provider: JsonRpcProvider,
    options: {
        poolInterval?: number;
        fromBlock?: string | number | bigint;
        toBlock?: string | number | bigint;
        address?: string | string[];
        topics?: string[] | (string | string[])[];
    },
    onLog: (log: Log) => void
): Promise<void> {
    const {
        poolInterval = 50,
        fromBlock = 'latest',
        toBlock = 'pending',
        address,
        topics,
    } = options;
    const seen = new Map<string, number>();
    const TTL = 60_000;

    const cleanup = (): void => {
        const now = Date.now();
        for (const [key, ts] of seen) {
            if (now - ts > TTL) seen.delete(key);
        }
    };

    while (true) {
        try {
            const getLogsStartMs = Date.now();
            const logs: unknown[] = await provider.send('eth_getLogs', [{
                fromBlock,
                toBlock,
                address,
                topics,
            }]);
            const getLogsMs = Date.now() - getLogsStartMs;

            if (Array.isArray(logs) && logs.length > 0) {
                const logsReceivedMs = Date.now();
                console.log(`[benchmark] eth_getLogs: ${getLogsMs}ms (${logs.length} log(s))`);
                for (const log of logs as Record<string, unknown>[]) {
                    const key = log.transactionHash
                        ? `${log.transactionHash}:${log.logIndex}`
                        : `${log.blockHash}:${log.address}:${(log.topics as string[])?.[0]}:${log.logIndex}`;
                    if (log.removed === true) {
                        seen.delete(key);
                        continue;
                    }
                    if (seen.has(key)) continue;
                    seen.set(key, Date.now());
                    try {
                        const normalized = {
                            ...log,
                            logIndex: log.logIndex
                                ? parseInt(String(log.logIndex), 16)
                                : 0,
                            blockNumber: log.blockNumber
                                ? parseInt(String(log.blockNumber), 16)
                                : 0,
                            blockTimestamp: log.blockTimestamp
                                ? parseInt(String(log.blockTimestamp), 16)
                                : 0,
                            transactionIndex: log.transactionIndex
                                ? parseInt(String(log.transactionIndex), 16)
                                : 0,
                        };
                        console.log(`[benchmark] before onLog: +${Date.now() - logsReceivedMs}ms since logs received`);
                        onLog(normalized as unknown as Log);
                    } catch (cbErr) {
                        console.error('onLog handler error:', cbErr);
                    }
                }
                cleanup();
            }
        } catch (err) {
            console.error('Error fetching logs:', err);
        }
        await new Promise((r) => setTimeout(r, poolInterval));
    }
}

async function main(): Promise<void> {
    const sequencerUrl =
        process.env.SEQUENCER_URL ?? 'https://mainnet.base.org';
    const senderPk = process.env.SENDER_PK ?? process.env.PRIVATE_KEY;
    if (!senderPk) {
        throw new Error(
            '.env must set SENDER_PK or PRIVATE_KEY to sign and send the test tx'
        );
    }

    console.log('Approve listener + fast tx to sequencer');
    console.log('Sequencer:', sequencerUrl);

    const config = getConfigFromEnv();

    const provider = new JsonRpcProvider(
        config.network.rpcUrl,
        { chainId: config.network.id, name: 'custom' },
        { staticNetwork: true }
    );

    const wallet = new Wallet(senderPk, provider);
    const agent = new Agent({ keepAliveTimeout: 10_000 });

    const txParamsState: TxParamsState = {
        nonce: 0n,
        maxFeePerGas: 0n,
        maxPriorityFeePerGas: DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
        ready: false,
    };
    startTxParamsUpdater(
        provider,
        wallet.address,
        config.network.id,
        txParamsState
    );

    const sendPreparedTx = (triggerMs?: number): void => {
        if (!txParamsState.ready) {
            console.error('[Approval seen] Tx params not ready yet');
            return;
        }
        const nonce = txParamsState.nonce;
        const maxFeePerGas = txParamsState.maxFeePerGas;
        const maxPriorityFeePerGas = txParamsState.maxPriorityFeePerGas;
        const spender = config.approveSpender ?? wallet.address;
        const data = encodeApprove(spender, config.approveAmount);
        const signedTx = signTransactionEip1559(
            {
                nonce,
                maxFeePerGas,
                maxPriorityFeePerGas,
                gasLimit: APPROVE_GAS_LIMIT,
                to: config.approveTokenAddress,
                value: 0n,
                data,
                chainId: config.network.id,
            },
            senderPk
        );
        txParamsState.nonce = nonce + 1n;
        void sendRawTxFast({
            sequencerUrl,
            signedTx,
            agent,
        })
            .then((txHash) => {
                if (triggerMs !== undefined) {
                    console.log(`[benchmark] trigger→submit: ${Date.now() - triggerMs}ms`);
                }
                console.log('[Approval seen] Sent tx:', txHash);
            })
            .catch((err) => {
                console.error('[Approval seen] Send failed:', err);
                txParamsState.nonce = nonce;
            });
    };

    const approvalTopics = config.approveSenderAddress
        ? [APPROVAL_TOPIC, addressToTopic(config.approveSenderAddress)]
        : [APPROVAL_TOPIC];
    await listen(
        provider,
        {
            poolInterval: 50,
            address: [config.approveTokenAddress],
            topics: approvalTopics,
        },
        (log: Log) => {
            const triggerMs = Date.now();
            // console.log('[Approve]', log.address, 'tx', log.transactionHash);
            sendPreparedTx(triggerMs);
        }
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
