// Tiszta adatbázis minden E2E futás előtt (a webszerver indítása előtt fut).
import pg from "pg";
const c = new pg.Client({ connectionString: "postgres://th:th@localhost:5433/postgres" });
await c.connect();
await c.query("drop database if exists th_e2e with (force)");
await c.query("create database th_e2e");
await c.end();
