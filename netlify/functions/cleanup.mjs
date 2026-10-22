import {getStore} from '@netlify/blobs';
export default async()=>{
 const store=getStore({name:'agentos-demo',consistency:'strong'});let removed=0;
 for await(const page of store.list({paginate:true})){for(const row of page.blobs){if(!/^(sessions\/|claims\/|limits\/|users\/[^/]+\/runs\/)/.test(row.key))continue;const value=await store.getWithMetadata(row.key,{type:'json'});if(value?.metadata?.expiresAt<Date.now()){await store.delete(row.key);removed++;}}}
 return new Response(JSON.stringify({removed}));
};
export const config={schedule:'17 * * * *'};
