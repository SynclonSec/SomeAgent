import { Connection, PublicKey } from "@solana/web3.js";
import { Liquidity, LIQUIDITY_PROGRAM_ID_V4 } from "@raydium-io/raydium-sdk";
import tokenList from "@solana/spl-token-registry";

interface TokenMetadata {
    mint: string;
    symbol: string;
    name: string;
    decimals: number;
    logoURI?: string;
}

interface QuoteInput {
    sourceTokenMint: string;
    targetTokenMint: string;
    amount: number;
    slippageTolerance?: number;
    rpcEndpoint?: string;
    verbose?: boolean;
}

interface QuoteOutput {
    inputToken: {
        mint: string;
        symbol: string;
        name: string;
        decimals: number;
        amount: number;
        amountInBaseUnits: number;
    };
    outputToken: {
        mint: string;
        symbol: string;
        name: string;
        decimals: number;
        estimatedAmount: number;
        estimatedAmountInBaseUnits: number;
        minimumAmount: number;
        minimumAmountInBaseUnits: number;
    };
    fees: {
        tradeFee: number;
        ownerFee: number;
        tradeFeeInBaseUnits: number;
        ownerFeeInBaseUnits: number;
    };
    poolAddresses: string[];
}

function buildTokenMetadataMap(): Map<string, TokenMetadata> {
    const tokenMap = new Map<string, TokenMetadata>();
    const tokenRegistry = tokenList.filterByChainId(101);

    tokenRegistry.getList().forEach((token) => {
        tokenMap.set(token.address, {
            mint: token.address,
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            logoURI: token.logoURI,
        });
    });

    return tokenMap;
}

async function establishConnectionWithRetry(endpoint: string, retries: number): Promise<Connection> {
    let attempt = 0;
    while (attempt < retries) {
        try {
            const connection = new Connection(endpoint, "confirmed");
            await connection.getVersion();
            return connection;
        } catch (error) {
            attempt++;
            if (attempt >= retries) throw new Error("Failed to establish RPC connection after retries.");
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
    throw new Error("Connection failed after maximum retries");
}

async function getQuote(params: QuoteInput): Promise<QuoteOutput> {
    const {
        sourceTokenMint,
        targetTokenMint,
        amount,
        slippageTolerance = 0.5,
        rpcEndpoint = "https://api.mainnet-beta.solana.com",
        verbose = false,
    } = params;

    if (!sourceTokenMint || !targetTokenMint || amount <= 0) {
        throw new Error("Invalid parameters: Token mints must be valid, and amount must be greater than zero.");
    }

    const connection = await establishConnectionWithRetry(rpcEndpoint, 3);
    const tokenMetadataMap = buildTokenMetadataMap();

    try {
        // Fixed: Use fetchAllPoolKeys instead of fetchAllPools
        const pools = await Liquidity.fetchAllPoolKeys({
            connection,
            programId: LIQUIDITY_PROGRAM_ID_V4,
        });

        // Fixed: Use baseMint/quoteMint instead of tokenMintA/B
        const relevantPools = pools.filter((pool) => {
            const tokenA = pool.baseMint.toString();
            const tokenB = pool.quoteMint.toString();
            const isValidPair = (tokenA === sourceTokenMint && tokenB === targetTokenMint) ||
                               (tokenB === sourceTokenMint && tokenA === targetTokenMint);
            return isValidPair;
        });

        if (verbose) {
            console.log("Filtered Pools:", relevantPools.map((p) => p.id.toString()));
        }

        if (relevantPools.length === 0) {
            throw new Error("No relevant pools found for the specified token pair.");
        }

        // Fixed: Explicit swap direction handling
        const tradePromises = relevantPools.map(async (pool) => {
            const isSourceTokenBase = pool.baseMint.toString() === sourceTokenMint;
            const inputDecimals = isSourceTokenBase ? pool.baseDecimals : pool.quoteDecimals;
            const outputDecimals = isSourceTokenBase ? pool.quoteDecimals : pool.baseDecimals;

            try {
                // Fixed: Add explicit currency mints
                const tradeOptions = {
                    connection,
                    poolKeys: pool,
                    amountIn: amount,
                    currencyInMint: new PublicKey(sourceTokenMint),
                    currencyOutMint: new PublicKey(targetTokenMint),
                    slippage: slippageTolerance / 100,
                };
                
                const quote = await Liquidity.computeTrade(tradeOptions);
                return { pool, quote, inputDecimals, outputDecimals };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error";
                if (verbose) console.error(`Error processing pool ${pool.id.toString()}: ${errorMessage}`);
                return null;
            }
        });

        const trades = (await Promise.all(tradePromises)).filter(t => t !== null);
        if (trades.length === 0) throw new Error("No valid trades could be computed.");

        const bestTrade = trades.reduce((best, current) => 
            (!best || current.quote.estimatedAmountOut > best.quote.estimatedAmountOut) ? current : best
        );

        // Fixed: Use pool's decimals as fallback instead of token registry
        const inputTokenMetadata = tokenMetadataMap.get(sourceTokenMint) || {
            mint: sourceTokenMint,
            symbol: 'UNKNOWN',
            name: 'Unknown Token',
            decimals: bestTrade.inputDecimals,
        };

        const outputTokenMetadata = tokenMetadataMap.get(targetTokenMint) || {
            mint: targetTokenMint,
            symbol: 'UNKNOWN',
            name: 'Unknown Token',
            decimals: bestTrade.outputDecimals,
        };

        // Fixed: Proper decimal handling for all calculations
        const amountHuman = amount / Math.pow(10, bestTrade.inputDecimals);
        const feeDenominator = bestTrade.pool.tradeFeeDenominator.toNumber();
        
        const tradeFeeBase = (bestTrade.pool.tradeFeeNumerator.toNumber() / feeDenominator) * amount;
        const ownerFeeBase = (bestTrade.pool.ownerFeeNumerator.toNumber() / feeDenominator) * amount;
        
        const tradeFeeHuman = tradeFeeBase / Math.pow(10, bestTrade.inputDecimals);
        const ownerFeeHuman = ownerFeeBase / Math.pow(10, bestTrade.inputDecimals);

        const estimatedAmountHuman = bestTrade.quote.estimatedAmountOut / Math.pow(10, bestTrade.outputDecimals);
        const minimumAmountHuman = bestTrade.quote.minimumAmountOut / Math.pow(10, bestTrade.outputDecimals);

        return {
            inputToken: {
                mint: sourceTokenMint,
                symbol: inputTokenMetadata.symbol,
                name: inputTokenMetadata.name,
                decimals: bestTrade.inputDecimals,
                amount: amountHuman,
                amountInBaseUnits: amount,
            },
            outputToken: {
                mint: targetTokenMint,
                symbol: outputTokenMetadata.symbol,
                name: outputTokenMetadata.name,
                decimals: bestTrade.outputDecimals,
                estimatedAmount: estimatedAmountHuman,
                estimatedAmountInBaseUnits: bestTrade.quote.estimatedAmountOut,
                minimumAmount: minimumAmountHuman,
                minimumAmountInBaseUnits: bestTrade.quote.minimumAmountOut,
            },
            fees: {
                tradeFee: tradeFeeHuman,
                ownerFee: ownerFeeHuman,
                tradeFeeInBaseUnits: tradeFeeBase,
                ownerFeeInBaseUnits: ownerFeeBase,
            },
            poolAddresses: [bestTrade.pool.id.toString()],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        throw new Error(`Error during quote computation: ${errorMessage}`);
    }
}

// Example usage with real mint addresses
(async () => {
    try {
        const quote = await getQuote({
            sourceTokenMint: "So11111111111111111111111111111111111111112", // SOL
            targetTokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
            amount: 1_000_000, // 1 SOL in lamports
            verbose: true,
        });
        console.log("Detailed Swap Quote:", JSON.stringify(quote, null, 2));
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        console.error("Error:", errorMessage);
    }
})();
