export type Role = "customer" | "admin" | "service";

export interface Principal {
  subject: string;
  roles: ReadonlySet<string>;
}
