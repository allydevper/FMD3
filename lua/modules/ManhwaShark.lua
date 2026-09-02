----------------------------------------------------------------------------------------------------
-- Local Constants
----------------------------------------------------------------------------------------------------

local DirectoryPagination = '/series/a-z/'

----------------------------------------------------------------------------------------------------
-- Event Functions
----------------------------------------------------------------------------------------------------

-- Get the page count of the manga list of the current website.
function GetDirectoryPageNumber()
	local u = MODULE.RootURL .. '/series/a-z'

	if not HTTP.GET(u) then return net_problem end

	PAGENUMBER = tonumber(CreateTXQuery(HTTP.Document).XPathString(
		'//nav[@class="pg"]/a[@class="pg__n"][last()]'
	)) or 1

	return no_error
end

-- Get links and names from the manga list of the current website.
function GetNameAndLink()
	local page = URL + 1
	local u = MODULE.RootURL .. '/series/a-z'
	if page > 1 then
		u = MODULE.RootURL .. DirectoryPagination .. page
	end

	if not HTTP.GET(u) then return net_problem end

	local x = CreateTXQuery(HTTP.Document)
	for v in x.XPath('//article[@class="card"]//h3[@class="card__title"]/a').Get() do
		LINKS.Add(v.GetAttribute('href'))
		NAMES.Add(v.ToString())
	end

	return no_error
end

-- Get info and chapter list for the current manga.
function GetInfo()
	local u = MaybeFillHost(MODULE.RootURL, URL)

	if not HTTP.GET(u) then return net_problem end

	local x = CreateTXQuery(HTTP.Document)
	MANGAINFO.Title     = x.XPathString('//h1[@class="ttl"]')
	MANGAINFO.CoverLink = x.XPathString('//div[@class="cover"]/img/@src')
	MANGAINFO.Authors   = x.XPathString('//div[@class="syn"]//p')
	MANGAINFO.Status    = MangaInfoStatusIfPos(x.XPathString('//p[@class="meta2"]/span'), 'Emisión|emision', 'Completado')
	MANGAINFO.Summary   = x.XPathString('//meta[@name="description"]/@content')

	for v in x.XPath('//ol[@class="caps"]//a').Get() do
		MANGAINFO.ChapterLinks.Add(v.GetAttribute('href'))
		MANGAINFO.ChapterNames.Add(x.XPathString('./span[@class="caps__n"]', v))
	end
	MANGAINFO.ChapterLinks.Reverse()
	MANGAINFO.ChapterNames.Reverse()

	return no_error
end

-- Get the page count and/or page links for the current chapter.
function GetPageNumber()
	local u = MaybeFillHost(MODULE.RootURL, URL)

	if not HTTP.GET(u) then return false end

	CreateTXQuery(HTTP.Document).XPathStringAll('//div[@id="pages"]/img/@src', TASK.PageLinks)

	return true
end

-- Prepare the HTTP headers to download the image.
function BeforeDownloadImage()
	HTTP.Headers.Values['Referer'] = MODULE.RootURL

	return true
end

----------------------------------------------------------------------------------------------------
-- Module Initialization
----------------------------------------------------------------------------------------------------

function Init()
	local m = NewWebsiteModule()
	m.ID                       = '0bf1171f98e0cc1d8b03d7abc82ac940'
	m.Name                     = 'Manhwa Shark'
	m.RootURL                  = 'https://manhwashark.lat'
	m.Category                 = 'Spanish'
	m.OnGetDirectoryPageNumber = 'GetDirectoryPageNumber'
	m.OnGetNameAndLink         = 'GetNameAndLink'
	m.OnGetInfo                = 'GetInfo'
	m.OnGetPageNumber          = 'GetPageNumber'
	m.OnBeforeDownloadImage    = 'BeforeDownloadImage'
	m.SortedList               = true
end
