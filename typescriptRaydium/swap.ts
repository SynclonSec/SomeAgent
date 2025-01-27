import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { Liquidity, LIQUIDITY_PROGRAM_ID_V4 } from "@raydium-io/raydium-sdk";
import { getQuote, QuoteOutput } from "./getQuote";
import { establishConnectionWithRetry } from "./sharedUtils";

interface SwapParams {
    sourceTokenMint: string;
    targetTokenMint: string;
    amountInBaseUnits: number;
    slippageTolerance: number;
    userPublicKey: PublicKey;
    rpcEndpoint?: string;
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

export async function prepareSwapTransaction(params: SwapParams): Promise<SwapResponse> {
    const { sourceTokenMint, targetTokenMint, amountInBaseUnits, slippageTolerance, userPublicKey, rpcEndpoint } = params;

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

        return {
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
                expiresAt: Date.now() + 60_000
            }
        };

    } catch (error) {
        return {
            status: "error",
            error: sanitizeError(error),
            metadata: {
                quoteId: '',
                preparedAt: Date.now(),
                expiresAt: Date.now()
            }
        };
    }
}

export async function executeSwap(params: SwapParams): Promise<SwapResponse> {
    try {
        const preparation = await prepareSwapTransaction(params);
        if (preparation.status !== "success") throw new Error(preparation.error);

        const connection = await establishConnectionWithRetry(params.rpcEndpoint || "https://api.mainnet-beta.solana.com", 3);
        const transaction = VersionedTransaction.deserialize(
            Buffer.from(preparation.swapInstructions!.serializedTransaction, 'base64')
        );

        const signature = await connection.sendTransaction(transaction);
        await connection.confirmTransaction({
            signature,
            blockhash: preparation.swapInstructions!.recentBlockhash,
            lastValidBlockHeight: (await connection.getBlockhash(preparation.swapInstructions!.recentBlockhash)).value!.lastValidBlockHeight
        });

        return {
            status: "success",
            metadata: preparation.metadata
        };

    } catch (error) {
        return {
            status: "error",
            error: sanitizeError(error),
            metadata: {
                quoteId: '',
                preparedAt: Date.now(),
                expiresAt: Date.now()
            }
        };
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
