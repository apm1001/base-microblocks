/**
 * Sends an ERC20 Approve tx from the wallet whose address is APPROVE_SENDER_ADDRESS.
 * Use this to trigger the pulling-listener (which filters Approval by that owner).
 *
 * Config from .env: RPC_URL, CHAIN_ID, APPROVE_TOKEN_ADDRESS, TRIGGER_PK (or APPROVE_SENDER_PK).
 * Optional: APPROVE_SPENDER (default: trigger wallet), APPROVE_AMOUNT (default: max uint256).
 *
 * Run: npx ts-node approve-trigger.ts
 */

import 'dotenv/config';
import { JsonRpcProvider, Wallet, ethers } from 'ethers';

const APPROVE_AMOUNT_MAX = (2n ** 256n) - 1n;

/** Config for trigger: network + token + optional spender/amount */
interface TriggerConfig {
    network: { rpcUrl: string; id: number };
    approveTokenAddress: string;
    approveSpender?: string;
    approveAmount?: bigint;
}

function getConfigFromEnv(): TriggerConfig {
    const rpcUrl = process.env.RPC_URL;
    const chainId = process.env.CHAIN_ID;
    const approveTokenAddress = process.env.APPROVE_TOKEN_ADDRESS;
    if (!rpcUrl || !chainId || !approveTokenAddress) {
        throw new Error(
            '.env must set RPC_URL, CHAIN_ID, APPROVE_TOKEN_ADDRESS'
        );
    }
    const approveAmount = process.env.APPROVE_AMOUNT
        ? BigInt(process.env.APPROVE_AMOUNT)
        : APPROVE_AMOUNT_MAX;
    const approveSpender = process.env.APPROVE_SPENDER?.toLowerCase();
    return {
        network: { rpcUrl, id: Number(chainId) },
        approveTokenAddress: approveTokenAddress.toLowerCase(),
        approveSpender,
        approveAmount,
    };
}

function encodeApprove(spender: string, amount: bigint): string {
    const iface = new ethers.Interface([
        'function approve(address spender, uint256 amount) returns (bool)',
    ]);
    return iface.encodeFunctionData('approve', [spender, amount]);
}

async function main(): Promise<void> {
    const triggerPk =
        process.env.TRIGGER_PK ?? process.env.APPROVE_SENDER_PK;
    if (!triggerPk) {
        throw new Error(
            '.env must set TRIGGER_PK or APPROVE_SENDER_PK (wallet that is APPROVE_SENDER_ADDRESS)'
        );
    }

    const config = getConfigFromEnv();

    const provider = new JsonRpcProvider(
        config.network.rpcUrl,
        { chainId: config.network.id, name: 'custom' },
        { staticNetwork: true }
    );

    const wallet = new Wallet(triggerPk, provider);
    const spender =
        config.approveSpender ?? wallet.address;
    const amount = config.approveAmount ?? APPROVE_AMOUNT_MAX;
    const data = encodeApprove(spender, amount);

    console.log('Approve trigger');
    console.log('Token:', config.approveTokenAddress);
    console.log('Sender (owner):', wallet.address);
    console.log('Spender:', spender);
    console.log('Amount:', amount.toString());

    const tx = await wallet.sendTransaction({
        to: config.approveTokenAddress,
        data,
        value: 0n,
        gasLimit: 100_000n,
    });

    console.log('Tx hash:', tx.hash);
    console.log('Wait for confirmation...');
    const receipt = await tx.wait();
    console.log('Block:', receipt?.blockNumber, 'Status:', receipt?.status === 1 ? 'success' : 'reverted');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
