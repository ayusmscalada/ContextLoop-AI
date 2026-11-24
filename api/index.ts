// Vercel serverless function for every /api route (see vercel.json and server/src/vercel.ts).
import { handle } from "../server/src/vercel.js";

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
