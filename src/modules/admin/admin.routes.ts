import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { rolePreHandler } from "../../auth/rbac.js";

function count(db: DatabaseSync, sql: string): number {
  return Number((db.prepare(sql).get() as { count: number }).count);
}

export async function registerAdminRoutes(app: FastifyInstance, db: DatabaseSync) {
  app.get("/api/v1/admin/overview", { preHandler: rolePreHandler("admin") }, async () => ({
    total_users: count(db, "SELECT COUNT(*) count FROM users"),
    active_users: count(db, "SELECT COUNT(*) count FROM users WHERE is_active=1"),
    admins: count(db, "SELECT COUNT(*) count FROM users WHERE role='admin' AND is_active=1"),
    customers: count(db, "SELECT COUNT(*) count FROM users WHERE role='customer' AND is_active=1"),
    recruiter_accounts: count(db, "SELECT COUNT(*) count FROM users WHERE role='recruiter' AND is_active=1"),
    recruiters: count(db, "SELECT COUNT(*) count FROM recruiters"),
    cities: count(db, "SELECT COUNT(*) count FROM cities"),
    positions: count(db, "SELECT COUNT(*) count FROM service_positions"),
    devices: count(db, "SELECT COUNT(*) count FROM agent_devices"),
    conversations: count(db, "SELECT COUNT(*) count FROM agent_conversations"),
    pending_activations: count(db, "SELECT COUNT(*) count FROM activation_records WHERE status IN ('pending_review','pending_send')"),
    retry_jobs: count(db, "SELECT COUNT(*) count FROM jobs WHERE status='retry'"),
    dead_jobs: count(db, "SELECT COUNT(*) count FROM jobs WHERE status='dead'"),
    rejected_webhooks: count(db, "SELECT COUNT(*) count FROM webhook_logs WHERE status='rejected'"),
  }));
}
