const messageIdPattern=/^<[^<>\s\r\n]{1,250}>$/;

export function parseDraftReplyHeaders(body:{
  in_reply_to?:unknown; references?:unknown
}):{inReplyTo:string|null;references:string|null}|null{
  const raw=body.in_reply_to;
  const inReplyTo=raw===undefined||raw===null||raw===""?null:
    typeof raw==="string"&&messageIdPattern.test(raw.trim())?raw.trim():null;
  if(raw!==undefined&&raw!==null&&raw!==""&&!inReplyTo)return null;
  const refs=body.references;
  if(refs!==undefined&&refs!==null&&(!Array.isArray(refs)||refs.length>20||
      !refs.every((value:unknown)=>typeof value==="string"&&messageIdPattern.test(value.trim()))))return null;
  const references=Array.isArray(refs)?refs.map(value=>(value as string).trim()).join(" ").slice(0,4000)||null:null;
  return {inReplyTo,references};
}
