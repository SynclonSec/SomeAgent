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

interface PoolInfo {
    poolAddress: string;
    tokenA: TokenMetadata & { reserve: string };
    tokenB: TokenMetadata & { reserve: string };
    liquidity: {
        totalSupply: string;
        openOrdersAddress: string;
        lpMint: string;
    };
    fees: {
        tradeFeePercentage: string;
        ownerFeePercentage: string;
        rawNumerators: {
            tradeFeeNumerator: number;
            tradeFeeDenominator: number;
            ownerFeeNumerator: number;
            ownerFeeDenominator: number;
        };
    };
    version: number;
}

/**
 * Safely converts BigInt reserves to human-readable string with proper decimal handling
 */
function normalizeReserve(reserve: bigint, decimals: number): string {
    const divisor = BigInt(10 ** decimals);
    const integerPart = reserve / divisor;
    const fractionalPart = reserve % divisor;
    return fractionalPart === BigInt(0)
        ? integerPart.toString()
        : `${integerPart}.${fractionalPart.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

/**
 * Establishes connection with retry logic and network verification
 */
async function establishConnectionWithRetry(endpoint: string, maxRetries = 3): Promise<Connection> {
    let attempt = 0;
    const retryDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 5000);

    while (attempt < maxRetries) {
        try {
            const connection = new Connection(endpoint, "confirmed");
            // Verify actual network connectivity
            await connection.getEpochInfo();
            return connection;
        } catch (error) {
            attempt++;
            if (attempt >= maxRetries) {
                throw new Error(`Failed to connect after ${maxRetries} attempts: ${error.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, retryDelay(attempt)));
        }
    }
    throw new Error("Unexpected error in connection establishment");
}

/**
 * Builds token metadata map with fallback values
 */
function buildTokenMetadataMap(): Map<string, TokenMetadata> {
    const tokenMap = new Map<string, TokenMetadata>();
    const tokens = tokenList.filterByChainId(101).getTokens();

    tokens.forEach(token => {
        tokenMap.set(token.address, {
            mint: token.address,
            symbol: token.symbol || "UNKNOWN",
            name: token.name || "Unknown Token",
            decimals: token.decimals ?? 0,
            logoURI: token.logoURI
        });
    });

    return tokenMap;
}

/**
 * Fetches and processes Raydium pools with enhanced error handling
 */
export async function fetchRaydiumPools(
    rpcEndpoint = "https://api.mainnet-beta.solana.com",
    maxRetries = 3
): Promise<PoolInfo[]> {
    const connection = await establishConnectionWithRetry(rpcEndpoint, maxRetries);
    const tokenMetadataMap = buildTokenMetadataMap();

    try {
        const pools = await Liquidity.fetchAllPools({
            connection,
            programId: LIQUIDITY_PROGRAM_ID_V4,
        });

        return pools
            .filter(pool => {
                // Validate pool liquidity
                const hasValidReserves = pool.tokenAReserve > BigInt(0) && pool.tokenBReserve > BigInt(0);
                const hasValidDecimals = pool.tokenMintADecimals > 0 && pool.tokenMintBDecimals > 0;
                return hasValidReserves && hasValidDecimals;
            })
            .map(pool => {
                try {
                    const tokenA = tokenMetadataMap.get(pool.tokenMintA.toBase58()) || {
                        mint: pool.tokenMintA.toBase58(),
                        symbol: "UNKNOWN",
                        name: "Unknown Token",
                        decimals: pool.tokenMintADecimals
                    };

                    const tokenB = tokenMetadataMap.get(pool.tokenMintB.toBase58()) || {
                        mint: pool.tokenMintB.toBase58(),
                        symbol: "UNKNOWN",
                        name: "Unknown Token",
                        decimals: pool.tokenMintBDecimals
                    };

                    return {
                        poolAddress: pool.id.toBase58(),
                        tokenA: {
                            ...tokenA,
                            reserve: normalizeReserve(pool.tokenAReserve, tokenA.decimals)
                        },
                        tokenB: {
                            ...tokenB,
                            reserve: normalizeReserve(pool.tokenBReserve, tokenB.decimals)
                        },
                        liquidity: {
                            totalSupply: normalizeReserve(pool.liquidity, pool.tokenMintADecimals),
                            openOrdersAddress: pool.openOrders.toBase58(),
                            lpMint: pool.lpMint.toBase58()
                        },
                        fees: {
                            tradeFeePercentage: ((pool.tradeFeeNumerator / pool.tradeFeeDenominator) * 100).toFixed(4),
                            ownerFeePercentage: ((pool.ownerFeeNumerator / pool.ownerFeeDenominator) * 100).toFixed(4),
                            rawNumerators: {
                                tradeFeeNumerator: pool.tradeFeeNumerator,
                                tradeFeeDenominator: pool.tradeFeeDenominator,
                                ownerFeeNumerator: pool.ownerFeeNumerator,
                                ownerFeeDenominator: pool.ownerFeeDenominator
                            }
                        },
                        version: 4 // Explicit version identification for compatibility
                    };
                } catch (error) {
                    console.error(`Error processing pool ${pool.id.toBase58()}: ${error.message}`);
                    return null;
                }
            })
            .filter((pool): pool is PoolInfo => pool !== null);
    } catch (error) {
        console.error("Critical error fetching pools:", error);
        throw new Error(`Failed to fetch pools: ${error.message}`);
    }
}

// Example usage (compatible with getQuotes.ts)
(async () => {
    try {
        const pools = await fetchRaydiumPools();
        console.log("Fetched", pools.length, "valid pools");
        console.log(JSON.stringify(pools.slice(0, 2), null, 2)); // Sample output
    } catch (error) {
        console.error("Error:", error.message);
        process.exit(1);
    }
})();
