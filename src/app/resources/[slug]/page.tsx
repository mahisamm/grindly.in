import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MarketingShell } from "@/components/MarketingShell";
import { MARKETING_RESOURCES, marketingResource } from "@/lib/marketing";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return MARKETING_RESOURCES.map((resource) => ({ slug: resource.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const resource = marketingResource((await params).slug);
  if (!resource) return {};
  const path = `/resources/${resource.slug}`;
  return {
    title: `${resource.title} — Grindly`,
    description: resource.description,
    alternates: { canonical: path },
    openGraph: { title: resource.title, description: resource.description, url: path },
  };
}

export default async function ResourcePage({ params }: Props) {
  const resource = marketingResource((await params).slug);
  if (!resource) notFound();
  return <MarketingShell resource={resource} />;
}
