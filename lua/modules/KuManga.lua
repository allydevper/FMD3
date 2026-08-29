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

local function isCloudflareBody(body)
	if body == nil or body == '' then return false end
	local b = body:lower()
	return b:find('just a moment', 1, true)
		or b:find('challenge-platform', 1, true)
		or b:find('cf-browser-verification', 1, true)
end

-- img.php?src=HEX hides the real CDN URL; downloading the proxy saves HTML as .jpg.
local readerUrl = ''

local function unwrapImgUrl(i)
	i = (i or ''):gsub('\\', '')
	if i == '' then return i end
	local hex = i:match('img%.php%?src=([0-9A-Fa-f]+)')
	if hex then
		local ok, decoded = pcall(function()
			return require('fmd.crypto').HexToStr(hex)
		end)
		if ok and type(decoded) == 'string' and decoded:match('^https?://') then
			return decoded
		end
	end
	return i
end

local function addPageLink(base, i)
	i = unwrapImgUrl(i)
	if i == nil or i == '' then return false end
	if i:match('^https?://') or i:match('^//') then
		TASK.PageLinks.Add(i)
	else
		TASK.PageLinks.Add(base .. i)
	end
	return true
end

local function addPagesFrom(body)
	if isCloudflareBody(body) then return false end
	local base = body:match('<base href="(.-)"')
	if base == nil or base == '' then base = MODULE.RootURL end
	local s = body:match('var%s+pUrl%s*=%s*(.-);')
		or body:match('let%s+pUrl%s*=%s*(.-);')
		or body:match('pUrl%s*=%s*(.-);')
	local n = 0
	local src = s or body
	for i in src:gmatch('"imgURL"%s*:%s*"(.-)"') do
		if addPageLink(base, i) then n = n + 1 end
	end
	if n == 0 then
		for i in src:gmatch('imgURL":"(.-)"') do
			if addPageLink(base, i) then n = n + 1 end
		end
	end
	return n > 0
end

-- Get the page count for the current chapter.
function GetPageNumber()
	local u = MaybeFillHost(MODULE.RootURL, URL)

	if u:find('/capitulo/') then
		print('KuManga: GET ficha ' .. u)
		if not HTTP.GET(u) then
			print('KuManga: GET ficha falló (red)')
			return net_problem
		end
		local landing = HTTP.Document.ToString() or ''
		if isCloudflareBody(landing) then
			print('KuManga: la ficha del capítulo sigue en Cloudflare')
			return information_not_found
		end
		local cid = landing:match('/manga/leer/(%d+)') or landing:match('/manga/c/(%d+)')
		if not cid then
			print('KuManga: no hay /manga/leer/ en la ficha (' .. tostring(#landing) .. ' bytes)')
			return information_not_found
		end
		HTTP.Headers.Values['Referer'] = ' ' .. u
		u = MaybeFillHost(MODULE.RootURL, '/manga/leer/' .. cid)
	end
	readerUrl = u

	print('KuManga: GET lector ' .. u)
	if not HTTP.GET(u) then
		print('KuManga: GET lector falló (red)')
		return net_problem
	end
	local body = HTTP.Document.ToString() or ''
	print('KuManga title: ' .. (body:match('<title>(.-)</title>') or '?'))
	if addPagesFrom(body) then
		print('KuManga: páginas OK (' .. TASK.PageLinks[0] .. ')')
		return no_error
	end
	print('KuManga: sin pUrl en reqwest (' .. tostring(#body) .. ' bytes); abriendo navegador interno')
	if HTTP.CaptureInBrowser(u) then
		body = HTTP.Document.ToString() or ''
		print('KuManga title(nav): ' .. (body:match('<title>(.-)</title>') or '?') .. ' (' .. tostring(#body) .. ' bytes)')
		if addPagesFrom(body) then
			print('KuManga: páginas OK (navegador) (' .. TASK.PageLinks[0] .. ')')
			return no_error
		end
	end
	if isCloudflareBody(body) then
		print('KuManga: el lector sigue en Cloudflare, sin pUrl')
	else
		print('KuManga: sin pUrl en el lector (' .. tostring(#body) .. ' bytes)')
	end
	return information_not_found
end

function BeforeDownloadImage()
	local ref = readerUrl
	if ref == nil or ref == '' then
		if TASK.CurrentDownloadChapterPtr < TASK.ChapterLinks.Count then
			ref = MaybeFillHost(MODULE.RootURL, TASK.ChapterLinks[TASK.CurrentDownloadChapterPtr])
		else
			ref = MODULE.RootURL
		end
	end
	HTTP.Headers.Values['Referer'] = ' ' .. ref
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
