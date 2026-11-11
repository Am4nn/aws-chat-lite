import type { MetadataRoute } from "next";

/** What the browser needs to install chat-lite as an app, which is how iPhone Safari allows it push. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "chat-lite",
    short_name: "chat-lite",
    start_url: "/",
    display: "standalone",
    background_color: "#0A0C0D",
    theme_color: "#0A0C0D",
    icons: [{ src: "/icon", sizes: "512x512", type: "image/png" }],
  };
}
