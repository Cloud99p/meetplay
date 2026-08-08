/**
 * OmniLearn SDK - Core Client Implementation
 * 
 * Main client class for interacting with the OmniLearn knowledge layer
 */

import {
  OmniLearnClientConfig,
  RecordParams,
  RecordResponse,
  BatchRecordParams,
  BatchRecordResponse,
  SearchParams,
  SearchResponse,
  DeleteParams,
  DeleteResponse,
  StreamParams,
  StreamEvent,
  ServiceStats,
  HealthStatus,
  KnowledgeNode,
  OmniLearnError,
  RegisterSchemaParams,
  RegisterSchemaResponse,
  KnowledgeSchema,
  RegisterServiceParams,
  RegisterServiceResponse,
  ServiceInfo,
} from './types.js';

/**
 * OmniLearnClient - Universal knowledge layer client
 * 
 * Connect any service to OmniLearn's distributed intelligence network.
 * Record knowledge, search across domains, and stream real-time updates.
 * 
 * @example
 * ```typescript
 * const client = new OmniLearnClient({
 *   apiKey: 'omni_sk_xxx',
 *   apiBaseUrl: 'https://api.omnilearn.ai',
 *   serviceName: 'my-service',
 * });
 * 
 * // Record knowledge
 * await client.record({
 *   type: 'event_completed',
 *   data: { eventId: '123', status: 'success' },
 * });
 * 
 * // Search knowledge
 * const results = await client.search({
 *   query: 'successful events',
 *   limit: 10,
 * });
 * ```
 */
export class OmniLearnClient {
  private config: Required<Omit<OmniLearnClientConfig, 'serviceVersion' | 'enableLogging'>> & {
    serviceVersion?: string;
    enableLogging: boolean;
  };
  
  private apiKey: string;
  private baseUrl: string;
  private serviceName: string;

  constructor(config: OmniLearnClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.apiBaseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.serviceName = config.serviceName;
    
    this.config = {
      apiKey: config.apiKey,
      apiBaseUrl: this.baseUrl,
      serviceName: this.serviceName,
      domain: config.domain || 'general',
      retryAttempts: config.retryAttempts ?? 3,
      timeout: config.timeout ?? 30000,
      enableLogging: config.enableLogging ?? false,
      serviceVersion: config.serviceVersion,
    };

    this.log('[OmniLearnClient] Initialized', {
      serviceName: this.serviceName,
      baseUrl: this.baseUrl,
      domain: this.config.domain,
    });
  }

  // ============================================================================
  // KNOWLEDGE RECORDING
  // ============================================================================

  /**
   * Record a single knowledge node (fire-and-forget)
   * 
   * @param params - Record parameters
   * @returns Promise resolving when recorded (no response data)
   * 
   * @example
   * ```typescript
   * await client.record({
   *   type: 'asset_issued',
   *   data: {
   *     assetId: 'asset_123',
   *     assetType: 'treasury-bond',
   *     totalValue: 1000000,
   *     issuer: 'US Treasury',
   *   },
   *   metadata: {
   *     userId: 'user_456',
   *   },
   * });
   * ```
   */
  async record(params: RecordParams): Promise<void> {
    this.log('[record] Recording knowledge', params);
    
    try {
      await this.request<RecordResponse>('POST', '/api/v1/knowledge/record', {
        ...params,
        metadata: {
          ...params.metadata,
          serviceName: this.serviceName,
          serviceVersion: this.config.serviceVersion,
          domain: this.config.domain,
        },
      });
      
      this.log('[record] Knowledge recorded successfully');
    } catch (error) {
      this.log('[record] Failed to record knowledge', error);
      throw error;
    }
  }

  /**
   * Record knowledge and wait for acknowledgment
   * 
   * @param params - Record parameters
   * @returns Record response with node ID and proof hash
   * 
   * @example
   * ```typescript
   * const response = await client.recordAndWait({
   *   type: 'trade_executed',
   *   data: { tradeId: '123', price: 50000 },
   * });
   * console.log('Node ID:', response.nodeId);
   * console.log('Proof Hash:', response.proofHash);
   * ```
   */
  async recordAndWait(params: RecordParams): Promise<RecordResponse> {
    this.log('[recordAndWait] Recording knowledge with acknowledgment', params);
    
    const raw = await this.request<RecordResponse>('POST', '/api/v1/knowledge/record', {
      ...params,
      metadata: {
        ...params.metadata,
        serviceName: this.serviceName,
        serviceVersion: this.config.serviceVersion,
        domain: this.config.domain,
      },
    });
    
        // V1 server returns { success, nodeId, hash, timestamp } - normalize to SDK shape
    const response: RecordResponse = {
      nodeId: String(raw.nodeId ?? raw.hash ?? ''),
      proofHash: raw.hash ?? raw.proofHash,
      hash: raw.hash,
      timestamp: raw.timestamp,
      status: raw.success === false ? 'failed' : 'recorded',
      success: raw.success,
      error: raw.error,
    };
    
    this.log('[recordAndWait] Knowledge recorded', {
      nodeId: response.nodeId,
      proofHash: response.proofHash,
    });
    
    return response;
  }

  /**
   * Record multiple knowledge nodes in a single batch
   * 
   * @param params - Batch record parameters
   * @returns Batch record response with counts and node IDs
   * 
   * @example
   * ```typescript
   * const result = await client.recordBatch({
   *   records: [
   *     { type: 'event_1', data: { ... } },
   *     { type: 'event_2', data: { ... } },
   *     { type: 'event_3', data: { ... } },
   *   ],
   * });
   * console.log(`Recorded ${result.recorded} nodes, ${result.failed} failed`);
   * ```
   */
  async recordBatch(params: BatchRecordParams): Promise<BatchRecordResponse> {
    this.log('[recordBatch] Recording batch', { count: params.records.length });
    
    // Add service metadata to each record
    const records = params.records.map(record => ({
      ...record,
      metadata: {
        ...record.metadata,
        serviceName: this.serviceName,
        serviceVersion: this.config.serviceVersion,
        domain: this.config.domain,
      },
    }));
    
    const response = await this.request<BatchRecordResponse>(
      'POST',
      '/api/v1/knowledge/batch',
      { records, metadata: { ...params.metadata, serviceName: this.serviceName, serviceVersion: this.config.serviceVersion, domain: this.config.domain } }
    );
    
    this.log('[recordBatch] Batch recorded', {
      recorded: response.recorded,
      failed: response.failed,
    });
    
    return response;
  }

  // ============================================================================
  
  /**
   * Delete knowledge nodes by metadata filter (privacy purge)
   * 
   * @param params - Delete parameters (requires metadataFilter, e.g. { sessionId: 'session-123' })
   * @returns Delete response with deleted/matched counts
   * 
   * @example
   * ```typescript
   * const result = await client.delete({ metadataFilter: { sessionId: 'session-123' } });
   * console.log(`Deleted ${result.deleted} nodes`);
   * ```
   */
  async delete(params: DeleteParams): Promise<DeleteResponse> {
    this.log('[delete] Deleting knowledge by metadata', params.metadataFilter);
    
    const response = await this.request<DeleteResponse>(
      'POST',
      '/api/v1/knowledge/delete',
      { metadataFilter: params.metadataFilter }
    );
    
    this.log('[delete] Delete complete', { deleted: response.deleted, matched: response.matched });
    
    return response;
  }

  // ============================================================================
  // KNOWLEDGE SEARCH
  // ============================================================================
  // ============================================================================

  /**
   * Search the knowledge graph
   * 
   * @param params - Search parameters
   * @returns Search response with matching nodes
   * 
   * @example
   * ```typescript
   * const results = await client.search({
   *   query: 'treasury bond issuance trends',
   *   sources: ['canton-rwa', 'agentflow'],
   *   types: ['asset_issued', 'trade_executed'],
   *   limit: 20,
   * });
   * 
   * results.nodes.forEach(node => {
   *   console.log(node.data);
   * });
   * ```
   */
  async search(params: SearchParams): Promise<SearchResponse> {
    this.log('[search] Searching knowledge graph', params);
    
    // Map SDK plural types -> server singular type; pass metadataFilter through
    const body: Record<string, unknown> = {
      query: params.query,
      limit: params.limit,
      offset: params.offset,
      type: params.type ?? params.types?.[0],
      timeRange: params.timeRange,
      metadataFilter: params.metadataFilter,
    };
    
    const response = await this.request<{ success: boolean; results: any[]; total: number; query?: string }>(
      'POST',
      '/api/v1/knowledge/search',
      body
    );
    
    const nodes: KnowledgeNode[] = (response.results || []).map((r) => ({
      id: String(r.id),
      type: r.type,
      data: r.data || {},
      metadata: r.metadata || {},
      similarity: r.similarity,
      createdAt: r.createdAt,
      updatedAt: r.createdAt,
      source: 'omnilearn-v1',
    }));
    
    this.log('[search] Search complete', { total: response.total, returned: nodes.length });
    
    return { nodes, total: response.total ?? nodes.length, hasMore: false, searchTimeMs: undefined };
  }

  /**
   * Search with simple query string (GET method)
   * 
   * @param query - Natural language query
   * @param limit - Maximum results (default: 10)
   * @returns Array of matching knowledge nodes
   */
  async query(query: string, limit: number = 10): Promise<KnowledgeNode[]> {
    this.log('[query] Simple query', { query, limit });
    
    const response = await this.search({ query, limit });
    
    return response.nodes;
  }

  // ============================================================================
  // REAL-TIME STREAMING
  // ============================================================================

  /**
   * Stream real-time knowledge updates
   * 
   * @param params - Stream parameters
   * @returns AsyncIterable of stream events
   * 
   * @example
   * ```typescript
   * const stream = client.stream({
   *   types: ['asset_issued', 'trade_executed'],
   *   batchSize: 10,
   * });
   * 
   * for await (const event of stream) {
   *   console.log('New knowledge:', event.data);
   * }
   * ```
   */
  async *stream(params: StreamParams = {}): AsyncIterable<StreamEvent> {
    this.log('[stream] Starting stream', params);
    
    const streamUrl = `${this.baseUrl}/api/v1/knowledge/stream`;
    
    try {
      const response = await fetch(streamUrl, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(params),
      });
      
      if (!response.ok) {
        throw new OmniLearnError(
          `Stream connection failed: ${response.statusText}`,
          'STREAM_CONNECTION_FAILED',
          response.status
        );
      }
      
      const reader = response.body?.getReader();
      if (!reader) {
        throw new OmniLearnError('ReadableStream not supported', 'STREAM_NOT_SUPPORTED');
      }
      
      const decoder = new TextDecoder();
      let buffer = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.trim().startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              yield data as StreamEvent;
            } catch (e) {
              this.log('[stream] Failed to parse stream event', e);
            }
          }
        }
      }
    } catch (error) {
      this.log('[stream] Stream error', error);
      throw error;
    }
  }

  // ============================================================================
  // SERVICE MANAGEMENT
  // ============================================================================

  /**
   * Get current service statistics
   * 
   * @returns Service statistics
   * 
   * @example
   * ```typescript
   * const stats = await client.getStats();
   * console.log(`Nodes recorded: ${stats.nodesRecorded}`);
   * console.log(`API calls today: ${stats.apiCallsToday}`);
   * console.log(`Rate limit remaining: ${stats.rateLimitRemaining}`);
   * ```
   */
  async getStats(): Promise<ServiceStats> {
    this.log('[getStats] Fetching service statistics');
    
    const raw = await this.request<{ success: boolean; stats: ServiceStats }>('GET', '/api/v1/services/me/stats');
    return raw.stats;
  }

  /**
   * Get service information
   * 
   * @returns Service info including configuration and usage
   */
  async getServiceInfo(): Promise<ServiceInfo> {
    this.log('[getServiceInfo] Fetching service info');
    
    const raw = await this.request<{ success: boolean; stats: ServiceStats }>('GET', '/api/v1/services/me/stats');
    return raw.stats.serviceInfo;
  }

  /**
   * Register this service with OmniLearn and receive an API key.
   *
   * This is the onboarding flow for any external project: call it once at
   * startup (or via CLI) with your service details, and the platform returns
   * an API key to use for all subsequent client calls.
   *
   * @param params - Service registration details
   * @returns Registration response containing the generated API key
   *
   * @example
   * ```typescript
   * const reg = await client.registerService({
   *   name: 'my-trading-bot',
   *   ownerEmail: 'dev@example.com',
   *   domain: 'blockchain',
   *   description: 'Records trade executions for portfolio analytics',
   *   knowledgeTypes: ['trade_executed', 'position_closed'],
   * });
   * console.log('API key:', reg.apiKey);
   * ```
   */
  async registerService(params: RegisterServiceParams): Promise<RegisterServiceResponse> {
    this.log('[registerService] Registering service', params.name);
    
    return await this.request<RegisterServiceResponse>('POST', '/api/v1/services/register', params);
  }

  // ============================================================================
  // SCHEMA MANAGEMENT
  // ============================================================================

  /**
   * Register a new knowledge schema
   * 
   * @param params - Schema registration parameters
   * @returns Schema registration response
   * 
   * @example
   * ```typescript
   * await client.registerSchema({
   *   typeName: 'asset_issued',
   *   domain: 'blockchain',
   *   schema: {
   *     type: 'object',
   *     required: ['assetId', 'assetType', 'totalValue'],
   *     properties: {
   *       assetId: { type: 'string' },
   *       assetType: { type: 'string' },
   *       totalValue: { type: 'number' },
   *     },
   *   },
   * });
   * ```
   */
  async registerSchema(params: RegisterSchemaParams): Promise<RegisterSchemaResponse> {
    this.log('[registerSchema] Registering schema', params.typeName);
    
    return await this.request<RegisterSchemaResponse>('POST', '/api/v1/schemas', params);
  }

  /**
   * List all available schemas
   * 
   * @returns Array of knowledge schemas
   */
  async listSchemas(): Promise<KnowledgeSchema[]> {
    this.log('[listSchemas] Fetching schemas');
    
    const response = await this.request<{ schemas: KnowledgeSchema[] }>('GET', '/api/v1/schemas');
    return response.schemas;
  }

  // ============================================================================
  // HEALTH CHECK
  // ============================================================================

  /**
   * Check API health status
   * 
   * @returns Health status
   * 
   * @example
   * ```typescript
   * const health = await client.health();
   * if (health.status !== 'healthy') {
   *   console.warn('OmniLearn API is not healthy:', health.status);
   * }
   * ```
   */
  async health(): Promise<HealthStatus> {
    this.log('[health] Checking API health');
    
    return await this.request<HealthStatus>('GET', '/health');
  }

  // ============================================================================
  // INTERNAL HELPERS
  // ============================================================================

  /**
   * Make HTTP request to OmniLearn API
   */
  private async request<T>(method: string, path: string, body?: any): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.getHeaders();
    
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
      try {
        this.log('[request]', { method, url, attempt });
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);
        
        const response = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          const errorData: any = await response.json().catch(() => ({}));
          throw new OmniLearnError(
            errorData.message || `HTTP ${response.status}: ${response.statusText}`,
            errorData.code || 'HTTP_ERROR',
            response.status,
            errorData.details
          );
        }
        
        const data = await response.json();
        return data as T;
        
      } catch (error) {
        lastError = error as Error;
        
        if (attempt < this.config.retryAttempts) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff
          this.log('[request] Retry in', delay, 'ms');
          await this.sleep(delay);
        }
      }
    }
    
    throw lastError || new OmniLearnError('Request failed after all retries', 'MAX_RETRIES_EXCEEDED');
  }

  /**
   * Get request headers
   */
  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'X-Service-Name': this.serviceName,
      ...(this.config.serviceVersion && { 'X-Service-Version': this.config.serviceVersion }),
    };
  }

  /**
   * Log message if logging is enabled
   */
  private log(...args: any[]): void {
    if (this.config.enableLogging) {
      console.log('[OmniLearn]', ...args);
    }
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
