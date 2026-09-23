# Redis ACL — WhatsApp AI SaaS
# -------------------------------------------------------
# The default user is DISABLED. Every connection must
# authenticate with a named user and a password.
#
# The render step strips comment lines before loading this file: Redis ACL
# files accept commands only. The original template kept the comments in and
# used the invalid keyword `nokeys`, so `redis-server` aborted at startup with
# "should start with user keyword" / "Syntax error" and never listened at all.
# -------------------------------------------------------

user default off nopass resetkeys nocommands

# NOTE on command grants: every service also needs +ping (container health
# checks), +info (ioredis runs a ready check with INFO at connect time and logs
# a NOPERM warning without it), and the consumers additionally need +scan /
# +keys / +xautoclaim — both consumer loops discover tenant streams with SCAN
# and re-claim stuck entries with XAUTOCLAIM. tenant_api_user needs +getdel for
# the single-use Meta OAuth state store. Omitting any of these made the owning
# service fail at runtime with a NOPERM error.
#
# gateway_user — publish envelopes to flow-engine streams, read/write the
# tenant routing cache, set processed:* idempotency keys
user gateway_user on >${REDIS_GATEWAY_PASSWORD} +xadd +get +set +setex +expire +ping +info ~tenant:by_phone:* ~flow-engine:* ~processed:*

# flow_engine_user — consume flow-engine streams, sessions, locks, rate limits
user flow_engine_user on >${REDIS_FLOW_ENGINE_PASSWORD} +xreadgroup +xack +xpending +xclaim +xautoclaim +xadd +scan +keys +ping +info +hgetall +hset +expire +set +get +del +incr +exists ~session:* ~flow-engine:* ~lock:flow:* ~rate:tenant:* ~processed:* ~tokens:tenant:* ~dry-session:*

# tenant_api_user — publish indexing jobs, invalidate tenant cache, auth
# blocklist, rate limiting writes, single-use Meta OAuth state (set/getdel)
user tenant_api_user on >${REDIS_TENANT_API_PASSWORD} +xadd +set +setex +del +get +getdel +ping +info ~tenant:by_phone:* ~indexing:* ~auth:blocklist:* ~rate:tenant:* ~oauth:meta:state:*

# rag_indexer_user — consume indexing streams only
user rag_indexer_user on >${REDIS_RAG_INDEXER_PASSWORD} +xreadgroup +xack +xpending +xclaim +xautoclaim +scan +keys +ping +info ~indexing:*
