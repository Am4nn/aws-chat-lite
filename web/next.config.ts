import type { NextConfig } from "next";


const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  agentRules: false,
  async headers() {
    // Inside another site's frame, a page laid over the app could trick a signed-in user into clicking Allow on
    // /consent or Remove on /apps (clickjacking). Every page gets the headers, because a framed /consent sends a
    // signed-out visitor on to /login, and the app never frames itself. X-Frame-Options covers older browsers that
    // ignore frame-ancestors.
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
