# Ninety Protocol - Backend

Welcome to the **Ninety Protocol** backend repository! This service powers the off-chain infrastructure for the Ninety prediction market.

## Overview

The Ninety backend is a robust Node.js application built with Express and TypeORM. It serves as the bridge between the on-chain Solana smart contract, the real-time data providers, and the Next.js frontend. It handles market lifecycle management, transaction indexing, real-time WebSocket communication, and payout processing.

## Tech Stack

- **Framework**: Express.js (TypeScript)
- **Database**: PostgreSQL (via TypeORM)
- **Caching & Queues**: Redis, BullMQ
- **Real-time**: Socket.io
- **Blockchain**: `@solana/web3.js`, `@coral-xyz/anchor`
- **Authentication**: TweetNaCl for cryptographic signature verification

## Features

- **Market Indexing**: Synchronizes on-chain market states with the PostgreSQL database.
- **Real-time Notifications**: Broadcasts live match updates and odds changes via Socket.io.
- **Queue Processing**: Manages background jobs for match resolutions and settlement using BullMQ.
- **Admin Dashboard API**: Provides protected routes for protocol keepers to manage configurations and monitor platform revenue.
- **Payout Handling**: Manages cashout requests and coordinates with the on-chain treasury.

## Getting Started

### Prerequisites

- Node.js (v20+)
- PostgreSQL database
- Redis server

### Installation

1. Clone the repository and navigate to the project directory:
   ```bash
   cd ninety-backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables in `.env` (Database credentials, Redis URL, Solana RPC, Keeper Keypair).

4. Run database migrations and synchronize the schema (TypeORM):
   ```bash
   npm run typeorm migration:run
   ```

5. Start the development server:
   ```bash
   npm run dev
   ```

## Architecture

- `/src/controllers` - Express route handlers.
- `/src/services` - Core business logic for markets, users, and transactions.
- `/src/entities` - TypeORM database models.
- `/src/jobs` - BullMQ queue processors and cron jobs.
- `/src/utils` - Solana transaction parsers and helper functions.
