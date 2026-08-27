import type { MetadataRoute } from "next";
import { MARKETING_RESOURCES } from "@/lib/marketing";

const ORIGIN = "https://grindly.in";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: ORIGIN, changeFrequency: "weekly", priority: 1 },
    { url: `${ORIGIN}/pricing`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${ORIGIN}/resources`, changeFrequency: "monthly", priority: 0.8 },
    ...MARKETING_RESOURCES.map((resource) => ({
      url: `${ORIGIN}/resources/${resource.slug}`,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ];
}
