----------------------------------------------------------------------------------------------------
-- Local Constants
----------------------------------------------------------------------------------------------------

local DirectoryPagination = '/backend/ajax/searchengine.php'
local DirectoryParameters = 'contentType=manga&retrieveCategories=true&retrieveAuthors=true&perPage=18&page='

----------------------------------------------------------------------------------------------------
-- Event Functions
----------------------------------------------------------------------------------------------------

-- Get info and chapter list for current manga.
function GetInfo()
	local u = MaybeFillHost(MODULE.RootURL, URL)
	if not HTTP.GET(u) then return net_problem end

	local x = CreateTXQuery(HTTP.Document)
	local body = HTTP.Document.ToString() or ''

	MANGAINFO.URL = x.XPathString('//meta[@property="og:url"]/@content')
	if MANGAINFO.URL == nil or MANGAINFO.URL == '' then
		MANGAINFO.URL = x.XPathString('//meta[@property="og:URL"]/@content')
	end
	if MANGAINFO.URL == nil or MANGAINFO.URL == '' then
		MANGAINFO.URL = u
	end

	MANGAINFO.Title = x.XPathString('//h1[contains(@class,"media-name__main")]/text()')
	if MANGAINFO.Title == nil or MANGAINFO.Title == '' then
		MANGAINFO.Title = x.XPathString('//meta[@property="og:title"]/@content')
	end
	MANGAINFO.CoverLink = x.XPathString('//meta[@property="og:image"]/@content')
	if MANGAINFO.CoverLink == nil or MANGAINFO.CoverLink == '' then
		MANGAINFO.CoverLink = x.XPathString('//img[contains(@class,"lazy-loaded")]/@data-src')
	end
	MANGAINFO.Status = MangaInfoStatusIfPos(
		x.XPathString('//div[contains(@class,"media-info-list__title") and contains(.,"Estado")]/following-sibling::div'),
		'emisi|Activo',
		'Finalizado'
	)
	MANGAINFO.Genres = x.XPathString('string-join(//div[contains(@class,"media-cats")]/a, ", ")')
	MANGAINFO.Summary = x.XPathString('//p[@id="idesc"]')
	if MANGAINFO.Summary == nil or MANGAINFO.Summary == '' then
		MANGAINFO.Summary = x.XPathString('//meta[@property="og:description"]/@content')
	end

	local json = x.XPathString('//script[@type="application/ld+json"]')
	if json ~= nil and json ~= '' then
		for capurl in json:gmatch('"url":"(https?://[^"]+/capitulo/[^"]+)"') do
			local num = capurl:match('/capitulo/(.+)$')
			MANGAINFO.ChapterLinks.Add(capurl)
			MANGAINFO.ChapterNames.Add('Capítulo ' .. (num or ''))
		end
	end

	if MANGAINFO.ChapterLinks.Count == 0 then
		x.XPathHREFAll('//a[contains(@class,"media-chapter__link")]', MANGAINFO.ChapterLinks, MANGAINFO.ChapterNames)
		local mangaId = URL:match('/manga/(%d+)') or body:match('"id"%s*:%s*(%d+)')
		local other = body:match('let OTHER_CHAPTERS%s*=%s*(%b[])')
		if other and mangaId then
			for num in other:gmatch('"NumCap":"([^"]+)"') do
				MANGAINFO.ChapterLinks.Add('/manga/' .. mangaId .. '/capitulo/' .. num)
				MANGAINFO.ChapterNames.Add('Capítulo ' .. num)
			end
		end
	end

	MANGAINFO.ChapterLinks.Reverse(); MANGAINFO.ChapterNames.Reverse()

	return no_error
end

-- Get the page count of the manga list of the current website.
function GetDirectoryPageNumber()
	local u = MODULE.RootURL .. DirectoryPagination

	if not HTTP.POST(u, DirectoryParameters .. '1') then return net_problem end

	local total = tonumber(CreateTXQuery(HTTP.Document).XPathString('json(*).totalContents') or '') or 0
	PAGENUMBER = math.ceil(total / 18)

	return no_error
end

-- Get LINKS and NAMES from the manga list of the current website.
function GetNameAndLink()
	local c, x = nil
	local u = MODULE.RootURL .. DirectoryPagination

	if not HTTP.POST(u, DirectoryParameters .. (URL + 1)) then return net_problem end

	x = CreateTXQuery(HTTP.Document)
	c = x.XPathCount('json(*).contents()')

	for i = 1, c do
		NAMES.Add(x.XPathString('json(*).contents(' .. i .. ').name'))
		LINKS.Add(x.XPathString('json(*).contents(' .. i .. ')/concat("/manga/",id,"/",slug)'))
	end

	return no_error
end

-- Get the page count for the current chapter.
function GetPageNumber()
	local u = MaybeFillHost(MODULE.RootURL, URL)

	-- Landing page /manga/{id}/capitulo/{n} → reader /manga/leer/{chapterId}
	if u:find('/capitulo/') then
		if not HTTP.GET(u) then return net_problem end
		local landing = HTTP.Document.ToString() or ''
		local leer = landing:match('href="(/*manga/leer/%d+)"')
		if not leer then
			local cid = landing:match('/manga/c/(%d+)')
			if cid then leer = '/manga/leer/' .. cid end
		end
		if not leer then return net_problem end
		u = MaybeFillHost(MODULE.RootURL, leer)
	else
		u = u:gsub('/c/', '/leer/')
	end

	if not HTTP.GET(u) then return net_problem end

	local body = HTTP.Document.ToString() or ''
	local base = body:match('<base href="(.-)"')
	if base == nil or base == '' then base = MODULE.RootURL end
	local s = body:match('var%s+pUrl%s*=%s*(.-);')
	if s then
		for i in s:gmatch('imgURL":"(.-)"') do
			TASK.PageLinks.Add(base .. i:gsub('\\',''))
		end
	end
	return no_error
end

function BeforeDownloadImage()
	if TASK.CurrentDownloadChapterPtr < TASK.ChapterLinks.Count then
		HTTP.Headers.Values['Referer'] = ' ' .. MaybeFillHost(MODULE.RootURL, TASK.ChapterLinks[TASK.CurrentDownloadChapterPtr])
	end
	return true
end

----------------------------------------------------------------------------------------------------
-- Module Initialization
----------------------------------------------------------------------------------------------------

function Init()
	local m = NewWebsiteModule()
	m.ID                       = '6138f1a985cd47c3b60a65cf6b1fe03d'
	m.Name                     = 'KuManga'
	m.RootURL                  = 'https://www.kumanga.com'
	m.Category                 = 'Spanish'
	m.OnGetInfo                = 'GetInfo'
	m.OnGetNameAndLink         = 'GetNameAndLink'
	m.OnGetPageNumber          = 'GetPageNumber'
	m.OnGetDirectoryPageNumber = 'GetDirectoryPageNumber'
	m.OnBeforeDownloadImage    = 'BeforeDownloadImage'
end
