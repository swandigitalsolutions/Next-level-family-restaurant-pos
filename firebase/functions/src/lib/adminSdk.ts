/**
 * Lazy Admin SDK accessors. Kept tiny and side-effect-light so unit tests can
 * mock `repo.ts` / `authService.ts` (which sit on top of these) without ever
 * touching a real project.
 */
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

export const db = () => getFirestore();
export const authAdmin = () => getAuth();
export { FieldValue, Timestamp };
