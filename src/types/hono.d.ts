import 'hono';

declare module 'hono' {
  interface ContextVariableMap {
    userId: number;
    userEmail: string;
    userRole: string;
  }
}
