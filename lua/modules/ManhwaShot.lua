----------------------------------------------------------------------------------------------------
-- ManhwaShot (manhwashot.lat) — Spanish manhwa/manga/manhua reader (Next.js SSR).
-- Series:  /manga/<slug>/
-- Chapter: /manga/<slug>/capitulo-<n>/   (also decimals: capitulo-5.1)
-- Images:  https://img.manhwashot.lat/img/WP-manga/data/...
----------------------------------------------------------------------------------------------------

function Init()
	local m = NewWebsiteModule()
	m.ID                       = 'a8c3e91f4b7d4e6a9f12c5d8e0b3a7c1'
	m.Name                     = 'ManhwaShot'
	m.RootURL                  = 'https://manhwashot.lat'
	m.Category                 = 'Spanish'
	m.OnGetNameAndLink         = 'GetNameAndLink'
	m.OnGetInfo                = 'GetInfo'
	m.OnGetPageNumber          = 'GetPageNumber'
	m.OnBeforeDownloadImage    = 'BeforeDownloadImage'
end

----------------------------------------------------------------------------------------------------
-- Local Constants
----------------------------------------------------------------------------------------------------

-- Category listing pages render a grid of series cards (SSR).
local DirectoryPages = {
	'/',
	'/manga-list/',
	'/shoujo/',
	'/bl/',
	'/adulto/',
}

----------------------------------------------------------------------------------------------------
-- Helper Functions
----------------------------------------------------------------------------------------------------

local function isSeriesHref(href)
	if not href or href == '' then return false end
	if not href:find('/manga/') then return false end
	if href:find('/capitulo-') or href:find('/wiki') or href:find('/resena') then return false end
	return true
end

local function normalizeSeriesHref(href)
	href = (href or ''):gsub('[?#].*$', ''):gsub('/+$', '') .. '/'
	return href
end

----------------------------------------------------------------------------------------------------
-- Event Functions
----------------------------------------------------------------------------------------------------

-- Get links and names from the manga list of the current website.
function GetNameAndLink()
	local seen = {}

	for i = 1, #DirectoryPages do
		local u = MODULE.RootURL .. DirectoryPages[i]
		if HTTP.GET(u) then
			local x = CreateTXQuery(HTTP.Document)
			for v in x.XPath('//a[contains(@class, "s-card-title")]').Get() do
				local href = normalizeSeriesHref(v.GetAttribute('href'))
				if isSeriesHref(href) and not seen[href] then
					seen[href] = true
					LINKS.Add(href)
					NAMES.Add(x.XPathString('string(.)', v))
				end
			end
			-- Homepage / extra cards that are not s-card-title.
			if LINKS.Count == 0 or DirectoryPages[i] == '/' then
				for v in x.XPath('//a[starts-with(@href, "/manga/")]').Get() do
					local href = normalizeSeriesHref(v.GetAttribute('href'))
					if isSeriesHref(href) and not seen[href] then
						seen[href] = true
						LINKS.Add(href)
						local name = x.XPathString('string(.)', v)
						if name == '' then name = v.GetAttribute('title') end
						NAMES.Add(name)
					end
				end
			end
		end
	end

	return no_error
end

-- Get info and chapter list for the current manga.
function GetInfo()
	local u = MaybeFillHost(MODULE.RootURL, URL)
	if not HTTP.GET(u) then return net_problem end

	local x = CreateTXQuery(HTTP.Document)
	MANGAINFO.Title     = Trim(x.XPathString('//h1[contains(@class, "series-title")]'))
	if MANGAINFO.Title == '' then
		MANGAINFO.Title = Trim(x.XPathString('//meta[@property="og:title"]/@content'))
	end
	MANGAINFO.CoverLink = x.XPathString('//div[contains(@class, "series-cover")]//img/@src')
	if MANGAINFO.CoverLink == '' then
		MANGAINFO.CoverLink = x.XPathString('//meta[@property="og:image"]/@content')
	end
	MANGAINFO.Summary   = Trim(x.XPathString('(//div[contains(@class, "series-desc")])[1]'))
	MANGAINFO.Status    = MangaInfoStatusIfPos(
		x.XPathString('//span[contains(@class, "badge-pill")]'),
		'emisión|Emisión|Ongoing',
		'Completado|Finalizado|Completed',
		'Pausado|Hiatus'
	)

	x.XPathHREFAll('//div[contains(@class, "chapters-grid")]/a[contains(@class, "ch-row")]', MANGAINFO.ChapterLinks, MANGAINFO.ChapterNames)
	if MANGAINFO.ChapterLinks.Count == 0 then
		x.XPathHREFAll('//a[contains(@href, "/capitulo-")]', MANGAINFO.ChapterLinks, MANGAINFO.ChapterNames)
	end
	-- Site lists newest first.
	MANGAINFO.ChapterLinks.Reverse()
	MANGAINFO.ChapterNames.Reverse()

	return no_error
end

-- Get the page count and/or page links for the current chapter.
function GetPageNumber()
	local u = MaybeFillHost(MODULE.RootURL, URL)
	if not HTTP.GET(u) then return false end

	local x = CreateTXQuery(HTTP.Document)
	x.XPathStringAll('//img[contains(@src, "WP-manga")]/@src', TASK.PageLinks)
	if TASK.PageLinks.Count == 0 then
		x.XPathStringAll('//main[contains(@class, "reader-main")]//img/@src', TASK.PageLinks)
	end

	-- Drop logo / cover / non-page images if the fallback path was used.
	if TASK.PageLinks.Count > 0 then
		local pages, seen = {}, {}
		for i = 0, TASK.PageLinks.Count - 1 do
			local src = TASK.PageLinks[i] or ''
			if src:find('WP-manga') or (src:find('img%.manhwashot%.lat') and not src:find('/images/') and not src:find('shot%-removebg')) then
				if not seen[src] then
					seen[src] = true
					pages[#pages + 1] = src
				end
			end
		end
		if #pages > 0 then
			TASK.PageLinks.Clear()
			for i = 1, #pages do
				TASK.PageLinks.Add(pages[i])
			end
		end
	end

	return true
end

-- Prepare the URL, http header and/or http cookies before downloading an image.
function BeforeDownloadImage()
	HTTP.Headers.Values['Referer'] = MODULE.RootURL .. '/'
	return true
end
