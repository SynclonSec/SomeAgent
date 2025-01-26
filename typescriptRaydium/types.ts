export interface TokenMetadata {
    mint: string;
    symbol: string;
    name: string;
    decimals: number;
    logoURI?: string;
}

export interface PoolInfo {
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
