import { Swapper } from "@/components/swapper";
import { normalizeAddress } from "@/lib/tokens";

type HomeProps = {
  searchParams: Promise<{ to?: string | string[] }>;
};

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;
  const rawTo = Array.isArray(params.to) ? params.to[0] : params.to;
  const houziAddress = normalizeAddress(rawTo);

  return <Swapper houziAddress={houziAddress} />;
}
