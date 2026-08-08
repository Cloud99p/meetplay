/**
 * OmniLearn SDK - Type Definitions
 * 
 * Core interfaces and types for the OmniLearn knowledge layer SDK
 */

// ============================================================================
// CLIENT CONFIGURATION
// ============================================================================

export interface OmniLearnClientConfig {
  /** Required: Service API key from OmniLearn dashboard */
  apiKey: string;
  
  /** Required: Base API URL (e.g., https://api.omnilearn.ai) */
  apiBaseUrl: string;
  
  /** Required: Unique service identifier (e.g., 'canton-rwa', 'tx-stack') */
  serviceName: string;
  
  /** Optional: Semantic version of your service */
  serviceVersion?: string;
  
  /** Optional: Number of retry attempts (default: 3) */
  retryAttempts?: number;
  
  /** Optional: Request timeout in ms (default: 30000) */
  timeout?: number;
  
  /** Optional: Enable debug logging (default: false) */
  enableLogging?: boolean;
  
  /** Optional: Domain category (e.g., 'blockchain', 'ecommerce', 'healthcare') */
  domain?: string;
}

// ============================================================================
// KNOWLEDGE RECORDING
// ============================================================================

export interface RecordParams {
  /** Required: Knowledge type (must match registered schema) */
  type: string;
  
  /** Required: Structured data matching the schema */
  data: Record<string, any>;
  
  /** Optional: Contextual metadata */
  metadata?: RecordMetadata;
  
  /** Optional: Pre-computed SHA-256 hash for proof chain */
  proofHash?: string;
  
  /** Optional: Priority level for processing */
  priority?: 'low' | 'normal' | 'high';
}

export interface RecordMetadata {
  /** User ID associated with this knowledge */
  userId?: string;
  
  /** Session ID for grouping related knowledge */
  sessionId?: string;
  
  /** ISO 8601 timestamp (auto-generated if not provided) */
  timestamp?: string;
  
  /** Additional custom metadata */
  [key: string]: any;
}

export interface RecordResponse {
  /** Unique identifier for the knowledge node */
  nodeId: string;
  
  /** SHA-256 hash for audit trail */
  proofHash?: string;
  
  /** Server hash field (raw passthrough) */
  hash?: string;
  
  /** Server timestamp */
  timestamp: string;
  
  /** Processing status */
  status: 'recorded' | 'queued' | 'failed';
  
  /** Success flag (V1 server) */
  success?: boolean;
  
  /** Error message if failed */
  error?: string;
}

export interface BatchRecordParams {
  /** Array of records to submit */
  records: RecordParams[];
  
  /** Optional: Top-level metadata persisted on every node in the batch */
  metadata?: RecordMetadata;
}

export interface BatchRecordResponse {
  /** Number of successfully recorded nodes */
  recorded: number;
  
  /** Number of failed records */
  failed: number;
  
  /** Node IDs for successful records */
  nodeIds: string[];
  
  /** Error details for failed records */
  errors?: Array<{
    index: number;
    error: string;
  }>;
}

// ============================================================================
// KNOWLEDGE SEARCH
// ============================================================================

export interface SearchParams {
  /** Required: Natural language search query */
  query?: string;
  
  /** Optional: Filter by service names */
  sources?: string[];
  
  /** Optional: Filter by knowledge types */
  types?: string[];
  
  /** Optional: Single knowledge type filter (direct server passthrough) */
  type?: string;
  
  /** Optional: Filter by domains (e.g., 'blockchain', 'ecommerce') */
  domains?: string[];
  
  /** Optional: Maximum results (default: 10, max: 100) */
  limit?: number;
  
  /** Optional: Pagination offset */
  offset?: number;
  
  /** Optional: Time range filter */
  timeRange?: TimeRange;
  
  /** Optional: Filter by metadata fields, e.g. { sessionId: 'session-123' } */
  metadataFilter?: RecordMetadata;
}

export interface TimeRange {
  /** Start timestamp (ISO 8601) */
  start: string;
  
  /** End timestamp (ISO 8601) */
  end: string;
}

export interface KnowledgeNode {
  /** Unique node identifier */
  id: string;
  
  /** Source service name */
  source: string;
  
  /** Knowledge type */
  type: string;
  
  /** Domain category */
  domain?: string;
  
  /** The actual knowledge data */
  data: Record<string, any>;
  
  /** Additional metadata */
  metadata?: RecordMetadata;
  
  /** Semantic embedding vector (for similarity search) */
  embedding?: number[];
  
  /** Cryptographic proof hash */
  proofHash?: string;
  
  /** Relevance score (0-1) */
  relevanceScore?: number;
  
  /** Creation timestamp */
  createdAt: string;
  
  /** Last update timestamp */
  updatedAt: string;
}

export interface SearchResponse {
  /** Matching knowledge nodes */
  nodes: KnowledgeNode[];
  
  /** Total matching results (for pagination) */
  total: number;
  
  /** Whether more results exist */
  hasMore: boolean;
  
  /** Search execution time in ms */
  searchTimeMs?: number;
}



export interface DeleteParams {
  /** Required: Metadata filter identifying nodes to delete, e.g. { sessionId: 'session-123' } */
  metadataFilter: RecordMetadata;
}

export interface DeleteResponse {
  /** Whether the operation succeeded */
  success: boolean;

  /** Number of nodes deleted */
  deleted: number;

  /** Number of nodes matched by the filter */
  matched: number;
}

// ============================================================================
// REAL-TIME STREAMING
// ============================================================================

export interface StreamParams {
  /** Optional: Filter by knowledge types */
  types?: string[];
  
  /** Optional: Filter by service names */
  sources?: string[];
  
  /** Optional: Filter by domains */
  domains?: string[];
  
  /** Optional: Batch size for streaming (default: 10) */
  batchSize?: number;
}

export interface StreamEvent {
  /** Event type */
  type: 'node' | 'edge' | 'heartbeat';
  
  /** The streamed data */
  data: KnowledgeNode | KnowledgeEdge | HeartbeatData;
  
  /** Server timestamp */
  timestamp: string;
}

export interface KnowledgeEdge {
  /** Edge identifier */
  id: string;
  
  /** Source node ID */
  sourceNodeId: string;
  
  /** Target node ID */
  targetNodeId: string;
  
  /** Relationship type */
  edgeType: 'correlation' | 'causation' | 'pattern' | 'temporal';
  
  /** Connection strength (-1.0 to 1.0) */
  strength: number;
  
  /** Number of observations supporting this edge */
  evidenceCount: number;
  
  /** Last observed timestamp */
  lastObserved: string;
}

export interface HeartbeatData {
  /** Service name */
  service: string;
  
  /** Status indicator */
  status: 'healthy' | 'degraded' | 'down';
  
  /** Latency in ms */
  latency: number;
}

// ============================================================================
// SERVICE STATISTICS
// ============================================================================

export interface ServiceStats {
  /** Total knowledge nodes recorded by this service */
  totalNodes: number;
  
  /** Total Hebbian edges created */
  totalEdges: number;
  
  /** Total records */
  totalRecords: number;
  
  /** Node counts grouped by type */
  nodesByType: Array<{ type: string; count: number }>;
  
  /** Recent activity entries */
  recentActivity: any[];
  
  /** Service identification */
  serviceInfo: ServiceInfo;
}

// ============================================================================
// HEALTH CHECK
// ============================================================================

export interface HealthStatus {
  /** Overall system health */
  status: 'healthy' | 'degraded' | 'down';
  
  /** API server status */
  apiStatus?: 'healthy' | 'degraded' | 'down';
  
  /** Database status */
  databaseStatus?: 'healthy' | 'degraded' | 'down';
  
  /** Response latency in ms */
  latencyMs?: number;
  
  /** Server version */
  version?: string;
  
  /** Server timestamp */
  timestamp?: string;
}

// ============================================================================
// ERROR HANDLING
// ============================================================================

export class OmniLearnError extends Error {
  constructor(
    message: string,
    public code: string,
    public status?: number,
    public details?: any
  ) {
    super(message);
    this.name = 'OmniLearnError';
  }
}

export interface ErrorResponse {
  /** Error code */
  code: string;
  
  /** Human-readable message */
  message: string;
  
  /** HTTP status code */
  status: number;
  
  /** Additional error details */
  details?: any;
}

// ============================================================================
// SCHEMA DEFINITIONS
// ============================================================================

export interface KnowledgeSchema {
  /** Schema identifier */
  id: string;
  
  /** Service that owns this schema */
  serviceName: string;
  
  /** Domain category */
  domain?: string;
  
  /** Type name (e.g., 'asset_issued', 'purchase_completed') */
  typeName: string;
  
  /** JSON Schema definition */
  schema: Record<string, any>;
  
  /** Schema version */
  version: number;
  
  /** Whether schema is active */
  isActive: boolean;
  
  /** Creation timestamp */
  createdAt: string;
}

export interface RegisterSchemaParams {
  /** Type name for this schema */
  typeName: string;
  
  /** Domain category */
  domain?: string;
  
  /** JSON Schema definition */
  schema: Record<string, any>;
}

export interface RegisterSchemaResponse {
  /** Schema identifier */
  schemaId: string;
  
  /** Type name */
  typeName: string;
  
  /** Schema version */
  version: number;
}

// ============================================================================
// SERVICE REGISTRATION
// ============================================================================

export interface RegisterServiceParams {
  /** Service name (unique identifier) */
  name: string;
  
  /** Service version */
  version?: string;
  
  /** Owner email */
  ownerEmail: string;
  
  /** Service description */
  description?: string;
  
  /** Domain category */
  domain?: string;
  
  /** Knowledge types this service will submit */
  knowledgeTypes?: string[];
  
  /** Rate limit per minute */
  rateLimit?: number;
}

export interface RegisterServiceResponse {
  /** Service identifier */
  serviceId: string;
  
  /** Generated API key */
  apiKey: string;
  
  /** API key prefix (for identification) */
  apiKeyPrefix: string;
  
  /** Service status */
  status: 'active' | 'pending' | 'suspended';
}

export interface ServiceInfo {
  /** Service name */
  name: string;
  
  /** Service version */
  version: string;
  
  /** Domain category */
  domain: string;
}
