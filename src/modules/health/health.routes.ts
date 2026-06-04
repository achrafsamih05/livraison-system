import { Router } from 'express';
import { getHealth } from './health.controller';
import { asyncHandler } from '../../shared/utils/asyncHandler';

const router = Router();

// GET /health — liveness + live Supabase connectivity probe.
router.get('/', asyncHandler(getHealth));

export default router;
