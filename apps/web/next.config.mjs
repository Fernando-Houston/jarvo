/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@hvi/shared"],
  reactStrictMode: true,
  // The page is fully client-side: static export → `out/`, deployable to
  // Cloudflare Pages with no server runtime.
  output: "export",
  // No floating "N" dev-tools button over the HUD.
  devIndicators: false,
};

export default nextConfig;
