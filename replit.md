# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Z2U Auto Fulfiller System

### Backend (artifacts/api-server)

A production-ready Node.js backend for automating Z2U order fulfillment via Lfollowers.

**New routes:**
- `GET /api/admin` — Admin dashboard UI (HTML)
- `GET /api/admin/mappings` — list all title → serviceId mappings
- `POST /api/admin/mappings` — add/update a mapping
- `DELETE /api/admin/mappings/:title` — delete a mapping
- `GET /api/admin/services` — fetch available Lfollowers services
- `POST /api/order` — place a Lfollowers order
- `POST /api/process-order` — receive XLSX + title + quantity, fill template, return filled file

**Mapping storage:** `artifacts/api-server/mappings.json` (flat JSON, git-tracked)

**Environment variables required:**
- `LFOLLOWERS_API_KEY` — your Lfollowers API key
- `PORT` — server port (default 3000)
- `SESSION_SECRET` — secret for session management

**Dependencies added:** `multer`, `exceljs`, `dotenv`, `axios`

### Chrome Extension (chrome-extension/)

Manifest V3 extension for Chrome that monitors Z2U and automates order fulfillment.

**Files:**
- `manifest.json` — extension manifest
- `config.js` — configurable SERVER_URL, refresh intervals
- `background.js` — service worker: alarm scheduling, message handling, backend API calls
- `content.js` — injected into z2u.com/sellOrder/index: scans orders, runs fulfillment sequence
- `popup.html` / `popup.js` — settings UI to configure backend URL

**To install:** Load `chrome-extension/` as unpacked extension in Chrome developer mode.

### README.md

Full deployment guide covering local setup, GitHub push, VPS deployment with PM2, and Nginx reverse proxy with SSL.
