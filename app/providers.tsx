"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, midnightTheme } from "@rainbow-me/rainbowkit";
import { useState } from "react";
import { WagmiProvider } from "wagmi";
import { apeChain, wagmiConfig } from "@/lib/web3";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          modalSize="compact"
          theme={midnightTheme({
            accentColor: "#ff4d57",
            accentColorForeground: "#080808",
            borderRadius: "large",
            fontStack: "system",
            overlayBlur: "small",
          })}
          initialChain={apeChain}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
