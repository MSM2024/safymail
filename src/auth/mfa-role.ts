export function mfaAuthenticatedUser(user: {
  user_id:string;email:string;display_name:string;is_superadmin:number
}) {
  return {
    id:user.user_id,
    email:user.email,
    displayName:user.display_name,
    isSuperadmin:user.is_superadmin===1,
    mfaEnabled:true
  };
}
