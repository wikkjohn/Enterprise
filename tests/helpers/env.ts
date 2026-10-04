export const TEST_ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://eaop:eaop@localhost:5432/eaop_test";
export const TEST_APP_URL = process.env.TEST_DATABASE_URL ?? "postgres://eaop_app:eaop_app@localhost:5432/eaop_test";
export const TEST_APP_ROLE = process.env.TEST_DATABASE_APP_ROLE ?? "eaop_app";
