export type DraftVersionFields={
 to_addresses:string;cc_addresses:string;bcc_addresses:string;
 subject:string;text_body:string|null;in_reply_to:string|null;references_header:string|null
};
export const DRAFT_FIELDS=[
 "to_addresses","cc_addresses","bcc_addresses","subject","text_body","in_reply_to","references_header"
] as const;
export async function getDraftVersion(draft:DraftVersionFields):Promise<string>{
 const encoded=JSON.stringify(DRAFT_FIELDS.map(key=>draft[key]??null));
 const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(encoded));
 return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
}
