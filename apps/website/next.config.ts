import type { NextConfig } from 'next'

const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  distDir: process.env.PI_WEBSITE_DIST_DIR || 'temp/cache/next',
  images: { unoptimized: true },
  devIndicators: false
}

export default config
