export const config = {
  host: process.env.REA_HOST ?? "127.0.0.1",
  port: Number(process.env.REA_PORT ?? 8080),
  jwtSecret: process.env.REA_LOCAL_JWT_SECRET ?? "local-development-secret",
  databasePath: process.env.REA_DATABASE_PATH ?? undefined,
};
