// @ts-check
import {
  defineConfig,
  fontProviders,
} from "astro/config";
import bettercms from "@bettercms-ai/astro";
import node from "@astrojs/node";


// https://astro.build/config
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [
    bettercms({
      apiUrl: "https://api.bettercms.ai",
      workspace: "himanshu-sahu",
      projectId: "YTyMFG37ZE4r2pTUgapeE",
    }),
  ],
  scopedStyleStrategy: 'where',
  fonts: [
    {
      provider: fontProviders.google(),
      name: "Roboto Slab",
      cssVariable: "--font-roboto-slab",
      weights: ["100 900"],
    },
    {
      provider: fontProviders.google(),
      name: "Inter",
      cssVariable: "--font-inter",
      weights: ["100 900"],
    },
  ],
});
