import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { sessionSchema, type Session } from './session';

const credentialDescriptor = z.object({ id:z.string(),type:z.literal('public-key'),transports:z.array(z.string()).optional() });
const authenticationOptions = z.object({ challenge:z.string(),timeout:z.number().optional(),rpId:z.string().optional(),allowCredentials:z.array(credentialDescriptor).optional(),userVerification:z.enum(['required','preferred','discouraged']).optional() });

function bytes(value:string): ArrayBuffer {
  const base64=value.replace(/-/g,'+').replace(/_/g,'/');
  return Uint8Array.from(atob(base64),(character)=>character.charCodeAt(0)).buffer;
}
export function base64url(value:ArrayBuffer):string { return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,''); }

export async function signInWithPasskey(api:ApiClient,identifier:string):Promise<ApiResult<Session>> {
  if(!identifier.trim()) return {ok:false,reason:'error',message:'Enter your email or handle before using a passkey.'};
  if(!window.isSecureContext || !window.PublicKeyCredential) return {ok:false,reason:'not_supported',message:'Passkeys require a secure browser connection.'};
  const options=await api.mutate('identity','webauthn.authOptions',{identifier},authenticationOptions);
  if(!options.ok)return options;
  try {
    const json=options.data;
    const credential=await navigator.credentials.get({publicKey:{...json,challenge:bytes(json.challenge),allowCredentials:json.allowCredentials?.map((item)=>({id:bytes(item.id),type:'public-key' as const,transports:item.transports as AuthenticatorTransport[]|undefined}))}});
    if(!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) return {ok:false,reason:'error',message:'No passkey assertion was returned.'};
    const response=credential.response;
    return api.mutate('identity','webauthn.authVerify',{identifier,credential:{id:credential.id,rawId:base64url(credential.rawId),type:'public-key',response:{clientDataJSON:base64url(response.clientDataJSON),authenticatorData:base64url(response.authenticatorData),signature:base64url(response.signature),userHandle:response.userHandle?base64url(response.userHandle):null},clientExtensionResults:credential.getClientExtensionResults()}},sessionSchema);
  }catch(error){return {ok:false,reason:'error',message:error instanceof DOMException && error.name==='NotAllowedError'?'Passkey sign-in was cancelled or timed out.':'The browser could not complete passkey sign-in.'};}
}
