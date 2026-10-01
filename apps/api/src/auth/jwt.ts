import { jwtVerify, SignJWT } from 'jose';
import { config } from '../config.js';

const key = new TextEncoder().encode(config.JWT_SECRET);
const ISSUER = 'salon-os';

export interface StaffTokenClaims {
  typ: 'staff';
  sub: string; // user id
  org: string;
  stf: string; // staff id
}

export interface CustomerTokenClaims {
  typ: 'customer';
  sub: string; // customer id
  org: string;
  via: 'line' | 'otp' | 'link';
}

export type TokenClaims = StaffTokenClaims | CustomerTokenClaims;

export async function signStaffAccessToken(claims: Omit<StaffTokenClaims, 'typ'>): Promise<string> {
  return new SignJWT({ typ: 'staff', org: claims.org, stf: claims.stf })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience('staff')
    .setIssuedAt()
    .setExpirationTime(`${config.JWT_ACCESS_TTL_SEC}s`)
    .sign(key);
}

export async function signCustomerToken(claims: Omit<CustomerTokenClaims, 'typ'>): Promise<string> {
  return new SignJWT({ typ: 'customer', org: claims.org, via: claims.via })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience('customer')
    .setIssuedAt()
    .setExpirationTime(`${config.CUSTOMER_JWT_TTL_SEC}s`)
    .sign(key);
}

export async function verifyToken(token: string): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, audience: ['staff', 'customer'] });
    if (payload.typ === 'staff' && typeof payload.sub === 'string') {
      return { typ: 'staff', sub: payload.sub, org: String(payload.org), stf: String(payload.stf) };
    }
    if (payload.typ === 'customer' && typeof payload.sub === 'string') {
      return {
        typ: 'customer',
        sub: payload.sub,
        org: String(payload.org),
        via: (payload.via as CustomerTokenClaims['via']) ?? 'link',
      };
    }
    return null;
  } catch {
    return null;
  }
}
