----------------------------------------------------------------------------------------------------
-- LectorXD (lectorxd.com) — Spanish manhwa/manga/manhua reader (Astro SSR).
-- Series: /manhwa/<slug>, /manga/<slug> or /manhua/<slug>
-- Chapter: /<type>/<slug>/leer/<n>
----------------------------------------------------------------------------------------------------

function Init()
	local m = NewWebsiteModule()
	m.ID                        = 'f4cfcaa6ca9b4e25b7cfd4a41bcce99c'
	m.Name                      = 'LectorXD'
	m.RootURL                   = 'https://lectorxd.com'
	m.Category                  = 'Spanish'
	m.OnGetDirectoryPageNumber  = 'GetDirectoryPageNumber'
	m.OnGetNameAndLink          = 'GetNameAndLink'
	m.OnGetInfo                 = 'GetInfo'
	m.OnGetPageNumber           = 'GetPageNumber'
	m.OnBeforeDownloadImage     = 'BeforeDownloadImage'
end

----------------------------------------------------------------------------------------------------
-- Local Constants
----------------------------------------------------------------------------------------------------

local DirectoryPagination = '/catalogo?page='

----------------------------------------------------------------------------------------------------
-- Helper Functions
----------------------------------------------------------------------------------------------------

local function fetchHtml(u)
	if not HTTP.GET(u) then return nil end
	local s = HTTP.Document.ToString() or ''
	-- Tiny IUAM page only. A 500KB ficha still contains leftover CF scripts.
	if HTTP.IsCloudflareChallenge(s) and #s < 20000 then
		print('LectorXD: sigue en Cloudflare (' .. tostring(#s) .. ' bytes)')
		return nil
	end
	return s
end

local function seriesBase(url)
	local base = (url or ''):gsub('[?#].*$', ''):gsub('/+$', '')
	base = base:match('https?://[^/]+(/.*)$') or base
	if base ~= '' and not base:match('^/') then
		base = '/' .. base
	end
	-- Drop a trailing /leer/<n> if a chapter URL was passed as the series URL.
	base = base:gsub('/leer/[^/]+$', '')
	return base
end

local function addChapter(seen, list, ch)
	if not ch or ch == '' or seen[ch] then return end
	seen[ch] = true
	list[#list + 1] = ch
end

local function chapterSortKey(ch)
	local n = tonumber(ch)
	if n then return n end
	local a, b = ch:match('^(%d+)%.(%d+)$')
	if a then return tonumber(a) + tonumber(b) / 1000 end
	return math.huge
end

----------------------------------------------------------------------------------------------------
-- Event Functions
----------------------------------------------------------------------------------------------------

-- Get the page count of the manga list of the current website.
function GetDirectoryPageNumber()
	local u = MODULE.RootURL .. DirectoryPagination .. 1
	if not HTTP.GET(u) then return net_problem end

	local last = 1
	local x = CreateTXQuery(HTTP.Document)
	for v in x.XPath('//a[contains(@href, "page=")]').Get() do
		local n = tonumber((v.GetAttribute('href') or ''):match('page=(%d+)'))
		if n and n > last then last = n end
	end
	PAGENUMBER = last

	return no_error
end

-- Get links and names from the manga list of the current website.
function GetNameAndLink()
	local u = MODULE.RootURL .. DirectoryPagination .. (URL + 1)
	if not HTTP.GET(u) then return net_problem end

	local x = CreateTXQuery(HTTP.Document)
	for v in x.XPath('//div[contains(@class, "manga-grid")]//a[contains(@class, "flex")]').Get() do
		LINKS.Add(v.GetAttribute('href'))
		NAMES.Add(x.XPathString('.//h4', v))
	end
	if LINKS.Count == 0 then
		for v in x.XPath('//a[starts-with(@href, "/manga/") or starts-with(@href, "/manhwa/") or starts-with(@href, "/manhua/")]').Get() do
			local href = v.GetAttribute('href') or ''
			if not href:find('/leer/') then
				LINKS.Add(href)
				local name = x.XPathString('.//h4', v)
				if name == '' then name = v.GetAttribute('title') end
				NAMES.Add(name)
			end
		end
	end

	return no_error
end

-- Get info and chapter list for the current manga.
function GetInfo()
	local u = MaybeFillHost(MODULE.RootURL, URL)
	local s = fetchHtml(u)
	if not s then
		MANGAINFO.Title = 'Cloudflare workaround is required'
		return no_error
	end

	local x = CreateTXQuery(s)
	MANGAINFO.Title     = Trim(x.XPathString('//h1'))
	if MANGAINFO.Title == '' then
		MANGAINFO.Title = Trim(x.XPathString('//meta[@property="og:title"]/@content'))
	end
	MANGAINFO.CoverLink = x.XPathString('//meta[@property="og:image"]/@content')
	MANGAINFO.Summary   = Trim(x.XPathString('//div[contains(@class,"prose")]//p'))
	if MANGAINFO.Summary == '' then
		MANGAINFO.Summary = Trim(x.XPathString('//div[contains(@class,"description")]'))
	end
	MANGAINFO.Genres    = x.XPathStringAll('//a[contains(@href, "catalogo?tags=")]')
	MANGAINFO.Status    = MangaInfoStatusIfPos(s, 'en_emision|En emisión', 'completado|Completado')

	local base = seriesBase(URL)
	local seen, chapters = {}, {}

	-- Embedded chaptersList / Astro props (supports decimals: "12.5").
	for ch in s:gmatch('"chapter":"([^"]+)"') do
		addChapter(seen, chapters, ch)
	end
	-- Visible reader links: /manhwa/<slug>/leer/1
	for ch in s:gmatch('/leer/([%d.]+)') do
		addChapter(seen, chapters, ch)
	end

	table.sort(chapters, function(a, b)
		local ka, kb = chapterSortKey(a), chapterSortKey(b)
		if ka == kb then return tostring(a) < tostring(b) end
		return ka < kb
	end)

	for i = 1, #chapters do
		MANGAINFO.ChapterLinks.Add(base .. '/leer/' .. chapters[i])
		MANGAINFO.ChapterNames.Add('Capítulo ' .. chapters[i])
	end

	print('LectorXD: ' .. MANGAINFO.Title .. ' (' .. tostring(MANGAINFO.ChapterLinks.Count) .. ' caps)')
	return no_error
end

-- Get the page count and/or page links for the current chapter.
function GetPageNumber()
	local u = MaybeFillHost(MODULE.RootURL, URL)
	local s = fetchHtml(u)
	if not s then return false end

	local function collectPages(html)
		local x = CreateTXQuery(html)
		x.XPathStringAll('//div[contains(@class, "page-container")]/img/@data-src', TASK.PageLinks)
		if TASK.PageLinks.Count == 0 then
			x.XPathStringAll('//div[contains(@class, "page-container")]//img/@data-src', TASK.PageLinks)
		end
		if TASK.PageLinks.Count == 0 then
			x.XPathStringAll('//div[contains(@class, "page-container")]//img/@src', TASK.PageLinks)
		end
		if TASK.PageLinks.Count == 0 then
			x.XPathStringAll('//img[contains(@class, "page-image")]/@src', TASK.PageLinks)
		end
	end

	collectPages(s)
	if TASK.PageLinks.Count == 0 then
		print('LectorXD: sin imágenes en HTML; capturando lector en navegador interno')
		if HTTP.CaptureInBrowser(u) then
			s = HTTP.Document.ToString() or ''
			if s ~= '' and not HTTP.IsCloudflareChallenge(s) then
				collectPages(s)
			end
		end
	end

	print('LectorXD: páginas ' .. tostring(TASK.PageLinks.Count) .. ' en ' .. u)
	return true
end

-- Prepare the URL, http header and/or http cookies before downloading an image.
function BeforeDownloadImage()
	HTTP.Headers.Values['Referer'] = MODULE.RootURL .. '/'
	return true
end
