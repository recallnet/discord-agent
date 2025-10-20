import { elizaLogger, IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import * as cheerio from 'cheerio';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

interface Document {
  id: string;
  title: string;
  content: string;
  url: string;
}

interface SearchResult {
  document: Document;
  relevanceScore: number;
}

interface VideoData {
  videos: Array<{
    title: string;
    videoId: string;
    summary: string;
    topics: string[];
    timestamps: Array<{
      time: string;
      description: string;
    }>;
    category: string;
    difficulty: string;
  }>;
  categories: string[];
  popularUseCases: string[];
}

export class WebDocScraper {
  private baseUrls: string[];
  private documents: Document[] = [];
  private videosDocuments: Document[] = [];
  private scrapedUrls = new Set<string>();
  private maxPages: number;
  private isScraped: boolean = false;
  private isScraping: boolean = false;
  private lastScrapedTime: number = 0;
  private cacheFilePath: string;
  private cacheDir: string = path.join(process.cwd(), 'content_cache');
  private videosJsonPath: string = path.join(process.cwd(), 'content_cache', 'videos.json');
  private cacheTTL: number = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  private initPromise: Promise<void> | null = null;

  constructor(baseUrls: string | string[], maxPages: number = 50) {
    // Support both single URL (backward compatible) and array of URLs
    this.baseUrls = (Array.isArray(baseUrls) ? baseUrls : [baseUrls])
      .map(url => url.endsWith('/') ? url : url + '/');
    this.maxPages = maxPages;
    // Create a combined cache filename from all URLs
    const combinedUrlKey = this.baseUrls.join('_').replace(/[^a-zA-Z0-9]/g, '_');
    this.cacheFilePath = path.join(this.cacheDir, `${combinedUrlKey}_cache.json`);
    
    // Create cache directory if it doesn't exist
    if (!fs.existsSync(this.cacheDir)) {
      try {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      } catch (error) {
        console.error('Failed to create cache directory:', error);
      }
    }
    
    // Initialize on construction
    this.initPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      // First load the videos.json if it exists
      await this.loadVideosJson();
      
      // Then load the web content cache
      await this.loadFromCache();
      
      // If cache is stale or empty, trigger a background refresh
      if (this.documents.length === 0 || 
          Date.now() - this.lastScrapedTime > this.cacheTTL) {
        this.backgroundScrape();
      }
    } catch (error) {
      console.error('Error initializing WebDocScraper:', error);
      // Even if loading from cache fails, we'll try scraping
      this.backgroundScrape();
    }
  }

  private async loadVideosJson(): Promise<void> {
    try {
      if (fs.existsSync(this.videosJsonPath)) {
        const videosData = fs.readFileSync(this.videosJsonPath, 'utf8');
        const videoJson: VideoData = JSON.parse(videosData);
        
        // Transform videos into documents
        this.videosDocuments = videoJson.videos.map(video => {
          // Create a content string that includes all searchable information
          const timestampsText = video.timestamps
            .map(ts => `${ts.time}: ${ts.description}`)
            .join('\n');
          
          const content = `
            ${video.title}
            ${video.summary}
            Topics: ${video.topics.join(', ')}
            Category: ${video.category}
            Difficulty: ${video.difficulty}
            Timestamps:
            ${timestampsText}
          `;
          
          return {
            id: `video-${video.videoId}`,
            title: video.title,
            content: content,
            url: `https://www.youtube.com/watch?v=${video.videoId}`
          };
        });
        
        console.log(`Loaded ${this.videosDocuments.length} video documents from videos.json`);
      }
    } catch (error) {
      console.error('Error loading videos.json:', error);
      this.videosDocuments = [];
    }
  }

  private async loadFromCache(): Promise<void> {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        const cacheData = fs.readFileSync(this.cacheFilePath, 'utf8');
        const cacheObj = JSON.parse(cacheData);
        
        this.documents = cacheObj.documents || [];
        this.scrapedUrls = new Set(cacheObj.scrapedUrls || []);
        this.lastScrapedTime = cacheObj.timestamp || 0;
        this.isScraped = this.documents.length > 0;
        
        console.log(`Loaded ${this.documents.length} documents from cache.`);
      }
    } catch (error) {
      console.error('Error loading from cache:', error);
      // If loading fails, we'll need to scrape
      this.documents = [];
      this.scrapedUrls = new Set();
      this.isScraped = false;
    }
  }

  private async saveToCache(): Promise<void> {
    try {
      const cacheObj = {
        documents: this.documents,
        scrapedUrls: Array.from(this.scrapedUrls),
        timestamp: Date.now()
      };
      
      fs.writeFileSync(this.cacheFilePath, JSON.stringify(cacheObj), 'utf8');
      console.log(`Saved ${this.documents.length} documents to cache.`);
    } catch (error) {
      console.error('Error saving to cache:', error);
    }
  }

  private backgroundScrape(): void {
    if (this.isScraping) return;
    
    this.isScraping = true;
    console.log('Starting background scraping process');
    
    // Start scraping in the background
    this.scrapeWebsite()
      .then(() => {
        this.lastScrapedTime = Date.now();
        this.saveToCache();
      })
      .catch(error => console.error('Background scraping error:', error))
      .finally(() => {
        this.isScraping = false;
      });
  }

  async ensureScraped(): Promise<void> {
    // Wait for initialization to complete
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
    
    // If we have no documents, we need to wait for scraping
    if (this.documents.length === 0 && !this.isScraped) {
      await this.scrapeWebsite();
      this.lastScrapedTime = Date.now();
      await this.saveToCache();
    }
  }

  async scrapeWebsite(): Promise<void> {
    if (this.isScraping) return;
    
    this.isScraping = true;
    console.log(`Starting to scrape ${this.baseUrls.length} site(s): ${this.baseUrls.join(', ')}`);
    
    try {
      // Scrape all base URLs
      for (const baseUrl of this.baseUrls) {
        await this.scrapeUrl(baseUrl);
      }
      this.isScraped = true;
      console.log(`Completed scraping. Indexed ${this.documents.length} pages.`);
    } catch (error) {
      console.error('Error scraping website:', error);
    } finally {
      this.isScraping = false;
    }
  }

  private async scrapeUrl(url: string, depth: number = 0): Promise<void> {
    // Check if URL belongs to any of our base URLs
    const belongsToBaseUrl = this.baseUrls.some(baseUrl => url.startsWith(baseUrl));
    
    if (
      this.scrapedUrls.has(url) || 
      this.documents.length >= this.maxPages ||
      depth > 3 || // Limit recursion depth
      !belongsToBaseUrl // Only scrape URLs within our base domains
    ) {
      return;
    }

    this.scrapedUrls.add(url);
    console.log(`Scraping ${url}`);

    try {
      const response = await axios.get(url, {
        timeout: 10000, // 10-second timeout
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RecallDocsBot/1.0)'
        }
      });
      
      const $ = cheerio.load(response.data);
      
      // Extract content
      // Remove navigation, headers, footers, etc.
      $('nav, header, footer, script, style').remove();
      
      // Get the main content
      const mainContent = $('main').length ? $('main').text() : $('body').text();
      const cleanedContent = this.cleanText(mainContent);
      
      // Get the title
      const title = $('title').text() || url.split('/').pop() || '';
      
      // Create a unique ID
      const id = this.urlToId(url);
      
      // Add to documents
      this.documents.push({
        id,
        title: this.cleanText(title),
        content: cleanedContent,
        url
      });

      // Find and follow links
      // Determine which base URL this page belongs to
      const currentBaseUrl = this.baseUrls.find(base => url.startsWith(base)) || this.baseUrls[0];
      
      const links = $('a[href]')
        .map((_, link) => {
          const href = $(link).attr('href') || '';
          if (href.startsWith('/')) {
            // Relative link - resolve against current base URL
            return new URL(href, currentBaseUrl).href;
          } else if (this.baseUrls.some(base => href.startsWith(base))) {
            // Absolute link within our domains
            return href;
          }
          return null;
        })
        .get()
        .filter(Boolean) as string[];

      // Recursively scrape found links
      for (const link of links) {
        if (link && !this.scrapedUrls.has(link)) {
          await this.scrapeUrl(link, depth + 1);
        }
      }
    } catch (error) {
      console.error(`Error scraping ${url}:`, error);
    }
  }

  private cleanText(text: string): string {
    return text
      .replace(/\s+/g, ' ')
      .replace(/\n+/g, '\n')
      .trim();
  }

  private urlToId(url: string): string {
    // Remove any matching base URL from the start
    let cleanedUrl = url;
    for (const baseUrl of this.baseUrls) {
      if (url.startsWith(baseUrl)) {
        cleanedUrl = url.replace(baseUrl, '');
        break;
      }
    }
    
    return cleanedUrl
      .replace(/\/$/, '')
      .replace(/[^a-zA-Z0-9]/g, '-')
      .toLowerCase() || 'home';
  }

  search(query: string, limit: number = 5): SearchResult[] {
    // If we have no documents but aren't scraping, trigger a background scrape
    if (this.documents.length === 0 && !this.isScraping) {
      this.backgroundScrape();
    }
    
    const queryTerms = query.toLowerCase().split(/\s+/);
    
    // Combined documents from both sources
    const allDocuments = [...this.documents, ...this.videosDocuments];
    
    let results = allDocuments.map(doc => {
      // Simple relevance scoring
      const contentLower = doc.content.toLowerCase();
      const titleLower = doc.title.toLowerCase();
      
      let score = 0;
      
      // Exact phrase match is highly relevant
      if (contentLower.includes(query.toLowerCase())) {
        score += 10;
      }
      
      // Title matches are very relevant
      if (titleLower.includes(query.toLowerCase())) {
        score += 15;
      }
      
      // Individual term matches
      for (const term of queryTerms) {
        if (term.length > 2) { // Ignore short terms
          if (contentLower.includes(term)) {
            score += 3;
          }
          if (titleLower.includes(term)) {
            score += 5;
          }
          
          // Boost score for exact word matches
          const wordRegex = new RegExp(`\\b${term}\\b`, 'i');
          if (wordRegex.test(contentLower)) {
            score += 2;
          }
          if (wordRegex.test(titleLower)) {
            score += 3;
          }
        }
      }
      
      // Boost videos a bit in the results when talking about tutorials or guides
      if (doc.id.startsWith('video-') && 
          (query.toLowerCase().includes('tutorial') || 
           query.toLowerCase().includes('guide') || 
           query.toLowerCase().includes('video') ||
           query.toLowerCase().includes('example') ||
           query.toLowerCase().includes('how to'))) {
        score += 5;
      }
      
      return { document: doc, relevanceScore: score };
    });
    
    // Filter out zero-score results and sort by relevance
    results = results
      .filter(result => result.relevanceScore > 0)
      .sort((a, b) => b.relevanceScore - a.relevanceScore);
    
    return results.slice(0, limit);
  }

  getDocument(id: string): Document | undefined {
    // Check both document sources
    return this.documents.find(doc => doc.id === id) || 
           this.videosDocuments.find(doc => doc.id === id);
  }

  getAllDocuments(): Document[] {
    return [...this.documents, ...this.videosDocuments];
  }
}

// Create a singleton instance of the scraper for both docs and blog
const recallDocsScraper = new WebDocScraper([
  'https://docs.recall.network/',
  'https://blog.recall.network/'
], 100); // Increased to 100 pages to accommodate both sources

export const recallDocsProvider: Provider = {
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ): Promise<Error | string> => {
    try {
      // Extract the query from the message
      const query = message.content.text.trim();
      
      // Ensure the documentation has been cached or is being scraped
      await recallDocsScraper.ensureScraped();
      
      // Search for relevant documents
      const results = recallDocsScraper.search(query, 3);
      
      if (results.length === 0) {
        return "No relevant documentation found for your query. Documentation may still be loading.";
      }
      
      // Format the results
      let response = `# Relevant documentation from Recall Network\n\n`;
      
      for (const result of results) {
        const doc = result.document;
        
        // Special formatting for video results
        if (doc.id.startsWith('video-')) {
          response += `## 📺 ${doc.title}\n`;
          response += `URL: ${doc.url}\n\n`;
          
          // Extract summary which is the second line in the content
          const contentLines = doc.content.trim().split('\n');
          const summary = contentLines[1]?.trim() || '';
          
          response += `${summary}\n\n`;
        } else {
          response += `## ${doc.title}\n`;
          response += `URL: ${doc.url}\n\n`;
          
          // Extract a snippet of content
          const snippet = doc.content;
          
          response += `${snippet}\n\n`;
        }
      }
      elizaLogger.info('docs provider response: ', JSON.stringify(response))
      return response;
    } catch (error) {
      return error instanceof Error
        ? error.message
        : "Unable to fetch documentation from Recall Network";
    }
  },
};

export default recallDocsProvider; 