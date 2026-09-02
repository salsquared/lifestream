/**
 * `/api/simulation` — the world-sim chain: per-country projection → Black Fever spread
 * → combine into nations → horizontal classification.
 *
 * Placeholder, and DEFERRED: the tables exist from P1 but the machinery has no phase.
 * See architecture.html §3.2–§3.5.
 */
import { Hono } from 'hono';

export const simulationRoutes = new Hono();
