#!/bin/bash

# Redirect stderr to stdout so command execution does not fail on stderr output.
exec 2>&1

set -e

# Directory containing this script (the scripts directory).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Project root is the parent of the scripts directory.
NEXTJS_PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Check that the project root exists.
if [ ! -d "$NEXTJS_PROJECT_DIR" ]; then
    echo "❌ Error: Next.js project directory does not exist: $NEXTJS_PROJECT_DIR"
    exit 1
fi

echo "🚀 Building the Next.js app and mini-services..."
echo "📁 Next.js project path: $NEXTJS_PROJECT_DIR"

# Switch to the project root.
cd "$NEXTJS_PROJECT_DIR" || exit 1

# Environment variables.
export NEXT_TELEMETRY_DISABLED=1

BUILD_DIR="/tmp/build_fullstack_$BUILD_ID"
echo "📁 Cleaning and creating build directory: $BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Install dependencies.
echo "📦 Installing dependencies..."
bun install

# Build the Next.js app.
echo "🔨 Building the Next.js app..."
bun run build

# Verify that the standalone server entrypoint was generated (deployment safety guard).
# Next only emits .next/standalone/server.js when next.config contains output:"standalone".
# If a user or AI edits the project and removes that setting, bun run build can still
# succeed (static output is generated, exit code 0) while standalone is missing. The
# deployment package would then have no server.js, start.sh would fail to find
# next-service-dist/server.js, Next would not start, and the reverse proxy at Caddy:81
# would point at an empty port 3000, causing the health check to time out.
# This self-heals only when standalone is genuinely missing: it restores
# output:"standalone" in next.config and rebuilds. Normal projects (which already
# generated server.js) skip this entire section without touching user files.
if [ ! -f ".next/standalone/server.js" ]; then
    echo "⚠️  Build did not produce .next/standalone/server.js; attempting to repair the output setting in next.config..."
    NEXT_CONFIG_FILE="$(ls next.config.ts next.config.js next.config.mjs next.config.cjs 2>/dev/null | head -1)"

    if [ -z "$NEXT_CONFIG_FILE" ]; then
        echo "❌ Build failed: no next.config.* found, cannot generate the standalone deployment artifact."
        exit 1
    fi

    if grep -Eq "output\s*:\s*['\"]standalone['\"]" "$NEXT_CONFIG_FILE"; then
        # standalone is already declared but server.js is still missing, which means
        # this is not a missing configuration issue (the build may have truly failed,
        # or a custom distDir is in use). Do not guess at the user's config; fail and
        # expose the reason.
        echo "❌ Build failed: $NEXT_CONFIG_FILE already contains output:\"standalone\", but .next/standalone/server.js was still not generated."
        echo "   Check the build errors above or the project's custom build configuration."
        exit 1
    fi

    if grep -Eq "output\s*:\s*['\"]" "$NEXT_CONFIG_FILE"; then
        # A different output value (such as "export" for static export, or anything
        # other than standalone) is already declared. "export" is incompatible with
        # this deployment model (standalone + custom server), and injecting a second
        # output key would not override the user's intent (later duplicate keys win
        # in a JS object). Fail explicitly.
        echo "❌ Build failed: $NEXT_CONFIG_FILE declares a non-standalone output (e.g. \"export\" static export), which is incompatible with this deployment model."
        echo "   This deployment requires output:\"standalone\". Change it to standalone, or confirm that this project should use static hosting instead of the deployment sandbox."
        exit 1
    fi

    echo "🔧 $NEXT_CONFIG_FILE is missing output:\"standalone\"; injecting it and rebuilding..."
    cp "$NEXT_CONFIG_FILE" "${NEXT_CONFIG_FILE}.zbak"
    # Insert output:"standalone" immediately after the first config object literal's {,
    # covering common scaffold forms: const nextConfig...= { / export default { / module.exports = {
    perl -0pi -e 's/((?:const\s+\w+[^=]*=|export\s+default|module\.exports\s*=)\s*\{)/$1\n  output: "standalone",/' "$NEXT_CONFIG_FILE"

    if ! grep -Eq "output\s*:\s*['\"]standalone['\"]" "$NEXT_CONFIG_FILE"; then
        echo "❌ Could not match an injectable config object. next.config has an unusual form and needs output:\"standalone\" added manually."
        echo "   Current contents of $NEXT_CONFIG_FILE:"
        cat "$NEXT_CONFIG_FILE"
        mv "${NEXT_CONFIG_FILE}.zbak" "$NEXT_CONFIG_FILE"
        exit 1
    fi

    echo "🔨 Injected output:\"standalone\"; rebuilding..."
    bun run build

    if [ ! -f ".next/standalone/server.js" ]; then
        echo "❌ After injecting output:\"standalone\" and rebuilding, .next/standalone/server.js is still missing."
        exit 1
    fi
    echo "✅ Self-repair succeeded: the standalone server entrypoint was generated."
fi

# Build mini-services.
# Check whether the project root has a mini-services directory.
if [ -d "$NEXTJS_PROJECT_DIR/mini-services" ]; then
    echo "🔨 Building mini-services..."
    # Use the mini-services scripts in the scripts directory.
    sh "$SCRIPT_DIR/mini-services-install.sh"
    sh "$SCRIPT_DIR/mini-services-build.sh"

    # Copy mini-services-start.sh into the mini-services-dist directory.
    echo "  - Copying mini-services-start.sh to $BUILD_DIR"
    cp "$SCRIPT_DIR/mini-services-start.sh" "$BUILD_DIR/mini-services-start.sh"
    chmod +x "$BUILD_DIR/mini-services-start.sh"
else
    echo "ℹ️  mini-services directory does not exist; skipping"
fi

# Copy all build artifacts into the temporary build directory.
echo "📦 Collecting build artifacts into $BUILD_DIR..."

# Copy the Next.js standalone build output.
if [ -d ".next/standalone" ]; then
    echo "  - Copying .next/standalone"
    cp -r .next/standalone "$BUILD_DIR/next-service-dist/"
fi

# Copy Next.js static files.
if [ -d ".next/static" ]; then
    echo "  - Copying .next/static"
    mkdir -p "$BUILD_DIR/next-service-dist/.next"
    cp -r .next/static "$BUILD_DIR/next-service-dist/.next/"
fi

# Copy the public directory.
if [ -d "public" ]; then
    echo "  - Copying public"
    cp -r public "$BUILD_DIR/next-service-dist/"
fi

# The Python runtime does not inherit the sandbox's $HOME/.venv. If the project
# contains Python sources or dependency manifests, freeze production dependencies
# into the artifact at build time while preserving project-relative source paths.
PROJECT_DIR="$NEXTJS_PROJECT_DIR" BUILD_DIR="$BUILD_DIR" \
    bash "$SCRIPT_DIR/python-runtime-build.sh"

# If a Preview database exists, copy its current data; otherwise initialize an
# empty production database directly in the deployment artifact. The template
# source does not ship db/custom.db, so it cannot assume dev.sh ran successfully
# before Deploy.
PROJECT_DIR="$NEXTJS_PROJECT_DIR" BUILD_DIR="$BUILD_DIR" \
    bash "$SCRIPT_DIR/database-runtime-build.sh"

# Copy the Caddyfile if present.
if [ -f "Caddyfile" ]; then
    echo "  - Copying Caddyfile"
    cp Caddyfile "$BUILD_DIR/"
else
    echo "ℹ️  Caddyfile does not exist; skipping"
fi

# Copy the start.sh script.
echo "  - Copying start.sh to $BUILD_DIR"
cp "$SCRIPT_DIR/start.sh" "$BUILD_DIR/start.sh"
chmod +x "$BUILD_DIR/start.sh"

# Package everything into $BUILD_DIR.tar.gz.
PACKAGE_FILE="${BUILD_DIR}.tar.gz"
echo ""
echo "📦 Packaging build artifacts into $PACKAGE_FILE..."
cd "$BUILD_DIR" || exit 1
tar -czf "$PACKAGE_FILE" .
cd - > /dev/null || exit 1

# # Clean up the temporary directory.
# rm -rf "$BUILD_DIR"

echo ""
echo "✅ Build complete! All artifacts were packaged into $PACKAGE_FILE"
echo "📊 Package size:"
ls -lh "$PACKAGE_FILE"
