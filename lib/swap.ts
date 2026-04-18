import RouterAbiJson from "@/app/abi/Router.json";
import QuoterAbiJson from "@/app/abi/Quoter.json";
import { erc20Abi } from "@/app/abi/erc20";
import { apeChain, apePublicClient } from "@/lib/web3";
import {
  getTokenAddressForRouter,
  QUOTER_ADDRESS,
  ROUTER_ADDRESS,
  type Token,
  WNATIVE_ADDRESS,
} from "@/lib/tokens";
import {
  concat,
  formatUnits,
  getAddress,
  maxUint256,
  type Abi,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";

const routerAbi = RouterAbiJson as Abi;
const quoterAbi = QuoterAbiJson as Abi;

export type QuoteRoute = {
  amountOut: bigint;
  path: Address[];
  routeType: "direct" | "multihop";
};

export async function fetchTokenMetadata(address: Address): Promise<Token> {
  const [name, symbol, decimals] = await Promise.all([
    apePublicClient.readContract({
      address,
      abi: erc20Abi,
      functionName: "name",
    }),
    apePublicClient.readContract({
      address,
      abi: erc20Abi,
      functionName: "symbol",
    }),
    apePublicClient.readContract({
      address,
      abi: erc20Abi,
      functionName: "decimals",
    }),
  ]);

  return {
    address,
    decimals,
    imported: true,
    name,
    symbol,
  };
}

export async function readAllowance(tokenAddress: Address, owner: Address) {
  return apePublicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, ROUTER_ADDRESS],
  });
}

export function buildRoutePath(path: Address[]): Hex {
  return concat(path);
}

export async function quoteBestRoute(tokenIn: Token, tokenOut: Token, amountIn: bigint) {
  const tokenInAddress = getTokenAddressForRouter(tokenIn);
  const tokenOutAddress = getTokenAddressForRouter(tokenOut);

  if (!tokenInAddress || !tokenOutAddress || amountIn <= 0n) {
    return null;
  }

  if (tokenInAddress === tokenOutAddress) {
    return {
      amountOut: amountIn,
      path: [tokenInAddress, tokenOutAddress],
      routeType: "direct",
    } satisfies QuoteRoute;
  }

  try {
    const direct = await apePublicClient.simulateContract({
      address: QUOTER_ADDRESS,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      args: [tokenInAddress, tokenOutAddress, amountIn, 0n],
    });

    return {
      amountOut: direct.result[0],
      path: [tokenInAddress, tokenOutAddress],
      routeType: "direct",
    } satisfies QuoteRoute;
  } catch {
    if (tokenInAddress === WNATIVE_ADDRESS || tokenOutAddress === WNATIVE_ADDRESS) {
      return null;
    }
  }

  try {
    const multiHopPath = [tokenInAddress, WNATIVE_ADDRESS, tokenOutAddress];
    const multiHop = await apePublicClient.simulateContract({
      address: QUOTER_ADDRESS,
      abi: quoterAbi,
      functionName: "quoteExactInput",
      args: [buildRoutePath(multiHopPath), amountIn],
    });

    return {
      amountOut: multiHop.result[0],
      path: multiHopPath,
      routeType: "multihop",
    } satisfies QuoteRoute;
  } catch {
    return null;
  }
}

export function formatDisplayAmount(value: bigint | null | undefined, decimals: number) {
  if (value === null || value === undefined) {
    return "0";
  }

  const [whole, fraction = ""] = formatUnits(value, decimals).split(".");
  const trimmed = fraction.replace(/0+$/, "").slice(0, 6);
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export function applySlippage(amountOut: bigint, bps: bigint) {
  return (amountOut * (10_000n - bps)) / 10_000n;
}

export function formatAddress(address: Address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export async function approveMaxToken({
  tokenAddress,
  walletClient,
  owner,
}: {
  owner: Address;
  tokenAddress: Address;
  walletClient: WalletClient;
}) {
  const hash = await walletClient.writeContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "approve",
    args: [ROUTER_ADDRESS, maxUint256],
    account: owner,
    chain: walletClient.chain ?? apeChain,
  });

  await apePublicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function addWalletWatchAsset(token: Token) {
  if (
    typeof window === "undefined" ||
    !("ethereum" in window) ||
    token.address === null ||
    token.isNative
  ) {
    return;
  }

  const provider = (window as Window & {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }).ethereum;

  if (!provider) {
    return;
  }

  try {
    await provider.request({
      method: "wallet_watchAsset",
      params: [
        {
          type: "ERC20",
          options: {
            address: getAddress(token.address),
            decimals: token.decimals,
            symbol: token.symbol,
          },
        },
      ],
    });
  } catch {
    // Ignore wallet watch errors because local importing is the primary flow.
  }
}

export { routerAbi };
