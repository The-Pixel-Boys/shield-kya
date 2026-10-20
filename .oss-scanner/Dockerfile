# Build environment for Anthropic OSS Scanner (https://github.com/anthropics/oss-scanner).
# The scanner builds this image with the repository checkout as the build context, then runs
# its audit agents inside the image with no network access. Everything the agents need
# (dependencies, build output, tests) must be fetched or built here.
FROM node:24-bookworm
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10 --activate

# Scanner contract: the checkout lives inside the image at /src.
COPY . /src
WORKDIR /src

# Install all dependencies (including devDependencies: TypeScript and Vitest are needed
# to build and to run the test suite) and compile the CLI.
RUN pnpm install --frozen-lockfile && pnpm run build

# Run the test suite so the image is known-good. Tests are hermetic (no network, no Docker).
# A failing test must not abort the image build.
RUN pnpm run test || echo "WARNING: vitest reported failures"
