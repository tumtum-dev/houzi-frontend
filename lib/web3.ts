import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { createPublicClient, defineChain, http } from "viem";

export const APECHAIN_RPC_URL = "https://rpc.apechain.com";
export const APECHAIN_EXPLORER_URL = "https://apechain.calderaexplorer.xyz";

export const apeChain = defineChain({
  id: 33139,
  name: "ApeChain",
  nativeCurrency: {
    decimals: 18,
    name: "ApeCoin",
    symbol: "APE",
  },
  rpcUrls: {
    default: {
      http: [APECHAIN_RPC_URL],
    },
    public: {
      http: [APECHAIN_RPC_URL],
    },
  },
  blockExplorers: {
    default: {
      name: "ApeChain Explorer",
      url: APECHAIN_EXPLORER_URL,
    },
  },
});

export const walletConnectProjectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "MISSING_PROJECT_ID";

export const wagmiConfig = getDefaultConfig({
  appName: "Houzi Swapper",
  appDescription: "ApeChain Houzi token swapper",
  appUrl: "https://houzi.local",
  projectId: walletConnectProjectId,
  chains: [apeChain],
  transports: {
    [apeChain.id]: http(APECHAIN_RPC_URL),
  },
  ssr: false,
});

export const apePublicClient = createPublicClient({
  chain: apeChain,
  transport: http(APECHAIN_RPC_URL),
});
