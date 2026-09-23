# Redis ACL — WhatsApp AI SaaS
# -------------------------------------------------------
# The default user is DISABLED. Every connection must
# authenticate with a named user and a password.
# -------------------------------------------------------

# default — disabled; no commands, no keys, no auth
user default off nopass nocommands nokeys

# NOTE on command grants: every service also needs +ping (container health
# checks) and the consumers additionally need +scan / +keys / +xautoclaim —
# both consumer loops discover tenant streams with SCAN and re-claim stuck
# entries with XAUTOCLAIM. Omitting these made every consumer silently
# process zero messages.

# gateway_user
# Responsibilities: publish envelopes to flow-engine streams,
#                   read/write tenant routing cache,
#                   set idempotency keys (processed:*)
user gateway_user on >${REDIS_GATEWAY_PASSWORD} \
  +xadd +get +set +setex +expire +ping \
  ~tenant:by_phone:* ~flow-engine:* ~processed:*

# flow_engine_user
# Responsibilities: consume flow-engine streams, manage sessions,
#                   distributed lock, rate limiting, idempotency
user flow_engine_user on >${REDIS_FLOW_ENGINE_PASSWORD} \
  +xreadgroup +xack +xpending +xclaim +xautoclaim +xadd \
  +scan +keys +ping \
  +hgetall +hset +expire \
  +set +get +del +incr +exists \
  ~session:* ~flow-engine:* ~lock:flow:* \
  ~rate:tenant:* ~processed:* ~tokens:tenant:* ~dry-session:*

# tenant_api_user
# Responsibilities: publish indexing jobs, invalidate tenant cache,
#                   auth blocklist, rate limiting writes
user tenant_api_user on >${REDIS_TENANT_API_PASSWORD} \
  +xadd +set +setex +del +get +ping \
  ~tenant:by_phone:* ~indexing:* ~auth:blocklist:* ~rate:tenant:* ~oauth:meta:state:*

# rag_indexer_user
# Responsibilities: consume indexing streams
user rag_indexer_user on >${REDIS_RAG_INDEXER_PASSWORD} \
  +xreadgroup +xack +xpending +xclaim +xautoclaim \
  +scan +keys +ping \
  ~indexing:*
