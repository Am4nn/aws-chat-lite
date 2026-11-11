import type { NextConfig } from "next";

/**
 * Pages where one click grants or removes an app's access. Inside another site's frame, a page laid over them could
 * trick a signed-in user into clicking Allow (clickjacking), so no site may frame them. X-Frame-Options covers older
 * browsers that ignore frame-ancestors.
 */
const FRAME_PROOF = ["/consent", "/apps"];

const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  agentRules: false,
  async headers() {
    return FRAME_PROOF.map((source) => ({
      source,
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    }));
  },
};

export default config;
