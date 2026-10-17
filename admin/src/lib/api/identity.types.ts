export type IdentityMe = {
  kind: 'admin' | 'user';
  id: string;
  email: string;
  name?: string | null;
  phone?: string | null;
  role: string;
  active?: boolean;
  status?: string;
  scopes?: Array<{
    scopeType: string;
    regionCode: string | null;
    territoryCode: string | null;
  }>;
  company?: {
    id: string;
    type: string;
    legalName: string | null;
    status: string;
  } | null;
};
