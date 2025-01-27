import { createHmac } from 'crypto';
import { Connection, PublicKey, VersionedTransaction, TransactionMessage } from "@solana/web3.js";
import { Liquidity, LIQUIDITY_PROGRAM_ID_V4 } from "@raydium-io/raydium-sdk";
import { getQuote, QuoteOutput } from "./getQuote";
import { establishConnectionWithRetry } from "./sharedUtils";

interface SecureResponse {
    data: any;
    sig: string;
}

function signResponse(data: object): SecureResponse {
    const hmac = createHmac('sha512', process.env.HMAC_SECRET!);
    return {
        data,
        sig: hmac.update(JSON.stringify(data)).digest('hex')
    };
}

interface SwapParams {
    sourceTokenMint: string;
    targetTokenMint: string;
    amountInBaseUnits: number;
    slippageTolerance: number;
    userPublicKey: PublicKey;
    rpcEndpoint?: string;
    nonce?: string; // Add nonce to SwapParams
}

interface SwapInstructions {
    transactionVersion: 'legacy' | 'v0';
    serializedTransaction: string;
    signers: PublicKey[];
    recentBlockhash: string;
    computeUnits: number;
}

interface SwapResponse {
    status: "success" | "error";
    swapInstructions?: SwapInstructions;
    error?: string;
    metadata?: {
        quoteId: string;
        preparedAt: number;
        expiresAt: number;
    };
}

export async function prepareSwapTransaction(params: SwapParams): Promise<SecureResponse> {
    const { sourceTokenMint, targetTokenMint, amountInBaseUnits, slippageTolerance, userPublicKey, rpcEndpoint, nonce } = params;

    try {
        const connection = await establishConnectionWithRetry(rpcEndpoint || "https://api.mainnet-beta.solana.com", 3);

        const quote = await getQuote({
            sourceTokenMint,
            targetTokenMint,
            amount: amountInBaseUnits,
            slippageTolerance,
            rpcEndpoint,
            verbose: false
        });

        const poolId = new PublicKey(quote.poolAddresses[0]);
        const poolKeys = await Liquidity.fetchPoolKeys({
            connection,
            poolId,
            programId: LIQUIDITY_PROGRAM_ID_V4
        });

        const swapInstructions = await Liquidity.makeSwapInstruction({
            connection,
            poolKeys,
            userKeys: {
                tokenAccountIn: await getAssociatedTokenAddress(userPublicKey, new PublicKey(sourceTokenMint)),
                tokenAccountOut: await getAssociatedTokenAddress(userPublicKey, new PublicKey(targetTokenMint)),
                owner: userPublicKey
            },
            amountIn: amountInBaseUnits,
            currencyInMint: new PublicKey(sourceTokenMint),
            currencyOutMint: new PublicKey(targetTokenMint),
            slippage: slippageTolerance / 100
        });

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const transaction = new VersionedTransaction(
            new TransactionMessage({
                payerKey: userPublicKey,
                recentBlockhash: blockhash,
                instructions: [swapInstructions]
            }).compileToV0Message()
        );

        const response = {
            status: "success",
            swapInstructions: {
                transactionVersion: 'v0',
                serializedTransaction: Buffer.from(transaction.serialize()).toString('base64'),
                signers: [userPublicKey],
                recentBlockhash: blockhash,
                computeUnits: 1_400_000
            },
            metadata: {
                quoteId: `swap-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
                preparedAt: Date.now(),
                expiresAt: Date.now() + 60_000,
                nonce: nonce // Include nonce in the response
            }
        };

        return signResponse(response);

    } catch (error) {
        const response = {
            status: "error",
            error: sanitizeError(error),
            metadata: {
                quoteId: '',
                preparedAt: Date.now(),
                expiresAt: Date.now(),
                nonce: nonce // Include nonce in the response
            }
        };

        return signResponse(response);
    }
}

export async function executeSwap(params: SwapParams): Promise<SecureResponse> {
    try {
        const preparation = await prepareSwapTransaction(params);
        if (preparation.data.status !== "success") throw new Error(preparation.data.error);

        const connection = await establishConnectionWithRetry(params.rpcEndpoint || "https://api.mainnet-beta.solana.com", 3);
        const transaction = VersionedTransaction.deserialize(
            Buffer.from(preparation.data.swapInstructions!.serializedTransaction, 'base64')
        );

        const signature = await connection.sendTransaction(transaction);
        await connection.confirmTransaction({
            signature,
            blockhash: preparation.data.swapInstructions!.recentBlockhash,
            lastValidBlockHeight: (await connection.getBlockhash(preparation.data.swapInstructions!.recentBlockhash)).value!.lastValidBlockHeight
        });

        const response = {
            status: "success",
            metadata: preparation.data.metadata
        };

        return signResponse(response);

    } catch (error) {
        const response = {
            status: "error",
            error: sanitizeError(error),
            metadata: {
                quoteId: '',
                preparedAt: Date.now(),
                expiresAt: Date.now(),
                nonce: params.nonce // Include nonce in the response
            }
        };

        return signResponse(response);
    }
}

async function getAssociatedTokenAddress(owner: PublicKey, mint: PublicKey): Promise<PublicKey> {
    return (await PublicKey.findProgramAddress(
        [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID
    ))[0];
}

function sanitizeError(error: any): string {
    const msg = error instanceof Error ? error.message : String(error);
    return msg.replace(/[^\w\s]/gi, '')
             .replace(/(secret|private|mnemonic)/gi, '*****')
             .substring(0, 200);
}

// Constants...
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
