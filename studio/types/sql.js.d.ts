// Hand-written types for sql.js 1.13 (server-worker.ts imports it from esm.sh): what the worker uses.
declare module "https://esm.sh/sql.js@1.13.0" {
  export type SqlValue = number | string | Uint8Array | bigint | null;
  export interface QueryExecResult {
    columns: string[];
    values: SqlValue[][];
  }
  export interface Statement {
    bind(values?: SqlValue[]): boolean;
    step(): boolean;
    get(params: SqlValue[] | null, config?: { useBigInt?: boolean }): SqlValue[];
    getColumnNames(): string[];
    free(): boolean;
  }
  export interface Database {
    exec(sql: string): QueryExecResult[];
    run(sql: string, params?: SqlValue[]): Database;
    prepare(sql: string): Statement;
    export(): Uint8Array<ArrayBuffer>;
    getRowsModified(): number;
  }
  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }
  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>;
}
