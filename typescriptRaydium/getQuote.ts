import { Connection } from "@solana/web3.js";
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
        const pools = await Liquidity.fetchAllPools({
            connection,
            programId: LIQUIDITY_PROGRAM_ID_V4,
        });

        const relevantPools = pools.filter((pool) => {
            const tokenA = pool.tokenMintA.toBase58();
            const tokenB = pool.tokenMintB.toBase58();
            const isValidPair = (tokenA === sourceTokenMint && tokenB === targetTokenMint) ||
                               (tokenB === sourceTokenMint && tokenA === targetTokenMint);
            return isValidPair && pool.tokenAReserve.gt(0) && pool.tokenBReserve.gt(0);
        });

        if (verbose) {
            console.log("Filtered Pools:", relevantPools.map((p) => p.id.toBase58()));
        }

        if (relevantPools.length === 0) {
            throw new Error("No relevant pools found for the specified token pair.");
        }

        const tradePromises = relevantPools.map(async (pool) => {
            const isSourceTokenA = pool.tokenMintA.toBase58() === sourceTokenMint;
            const inputDecimals = isSourceTokenA ? pool.tokenMintADecimals : pool.tokenMintBDecimals;
            const outputDecimals = isSourceTokenA ? pool.tokenMintBDecimals : pool.tokenMintADecimals;

            try {
                const tradeOptions = {
                    connection,
                    poolKeys: pool,
                    amountIn: amount,
                    slippage: slippageTolerance / 100,
                };
                const quote = await Liquidity.computeTrade(tradeOptions);
                return { pool, quote, inputDecimals, outputDecimals };
            } catch (error) {
                if (verbose) console.error(`Error processing pool ${pool.id.toBase58()}: ${error.message}`);
                return null;
            }
        });

        const trades = (await Promise.all(tradePromises)).filter(t => t !== null);
        if (trades.length === 0) throw new Error("No valid trades could be computed.");

        const bestTrade = trades.reduce((best, current) => 
            (!best || current.quote.estimatedAmountOut > best.quote.estimatedAmountOut) ? current : best
        );

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

        const amountHuman = amount / Math.pow(10, bestTrade.inputDecimals);
        const tradeFeeBase = (bestTrade.pool.tradeFeeNumerator / bestTrade.pool.tradeFeeDenominator) * amount;
        const ownerFeeBase = (bestTrade.pool.ownerFeeNumerator / bestTrade.pool.ownerFeeDenominator) * amount;
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
            poolAddresses: [bestTrade.pool.id.toBase58()],
        };
    } catch (error) {
        throw new Error(`Error during quote computation: ${error.message}`);
    }
}

(async () => {
    try {
        const quote = await getQuote({
            sourceTokenMint: "SOL_MINT_ADDR",
            targetTokenMint: "EXAMPLE_USDC_MINT_ADDR",
            amount: 1_000_000,
            verbose: true,
        });
        console.log("Detailed Swap Quote:", JSON.stringify(quote, null, 2));
    } catch (error) {
        console.error("Error:", error.message);
    }
})();
