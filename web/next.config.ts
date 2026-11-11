import type { NextConfig } from "next";

/**
 * No page may be framed by another site. Inside a frame, a page laid over the app could trick a signed-in user into
 * clicking Allow, Approve or Remove (clickjacking), and no page needs framing. X-Frame-Options covers older browsers
 * that ignore frame-ancestors.
 */
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  agentRules: false,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    }];
  },
};

export default config;
