import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/pricing", "/resources/"],
      disallow: ["/app/", "/admin/", "/api/", "/r/", "/login", "/signup", "/forgot", "/reset", "/verify", "/pending"],
    },
    sitemap: "https://grindly.in/sitemap.xml",
  };
}
