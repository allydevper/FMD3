----------------------------------------------------------------------------------------------------
-- TestCatalog — LOCAL DEV MOCK ONLY (http://localhost:1420/__test_catalog)
-- Does not hit real websites. Requires `tauri dev` (Vite middleware).
--
-- How to test:
--   1. Run tauri dev (Vite :1420 serves the mock).
--   2. Ajustes → Sitios Web → enable "TestCatalog" only (optional).
--   3. Catálogo → Actualizar lista (one site).
--   4. Scenarios: cancel mid-GetInfo; run update twice (SortedList early-stop).
--   5. Reset: delete %%AppData%%/fmd-mvp/data/ffffffffffffffffffffffffffffffff.db
--   Browser check: http://localhost:1420/__test_catalog/directorio?p=1
----------------------------------------------------------------------------------------------------

function Init()
	local m = NewWebsiteModule()
	m.ID                       = 'ffffffffffffffffffffffffffffffff'
	m.Name                     = 'TestCatalog'
	m.RootURL                  = 'http://localhost:1420/__test_catalog'
	m.Category                 = 'Test'
	m.SortedList               = true
	m.OnGetDirectoryPageNumber = 'GetDirectoryPageNumber'
	m.OnGetNameAndLink         = 'GetNameAndLink'
	m.OnGetInfo                = 'GetInfo'
	m.OnGetPageNumber          = 'GetPageNumber'
end

-- RootURL must be `localhost` (not 127.0.0.1) when Vite binds to the hostname only.

----------------------------------------------------------------------------------------------------
-- Local Constants
----------------------------------------------------------------------------------------------------

DirectoryPagination = '/directorio?p='

----------------------------------------------------------------------------------------------------
-- Event Functions
----------------------------------------------------------------------------------------------------

function GetDirectoryPageNumber()
	local u = MODULE.RootURL .. DirectoryPagination .. 1

	if not HTTP.GET(u) then return net_problem end

	PAGENUMBER = tonumber(CreateTXQuery(HTTP.Document).XPathString('//ul[@class="pagination"]/li[last()-1]/a')) or 1

	return no_error
end

function GetNameAndLink()
	local v, x = nil
	local u = MODULE.RootURL .. DirectoryPagination .. (URL + 1)

	if not HTTP.GET(u) then return net_problem end

	x = CreateTXQuery(HTTP.Document)
	for v in x.XPath('//div[@id="article-div"]//a').Get() do
		LINKS.Add(v.GetAttribute('href'))
		NAMES.Add(x.XPathString('span', v))
	end

	return no_error
end

function GetInfo()
	local v, x = nil
	local u = MaybeFillHost(MODULE.RootURL, URL)

	if not HTTP.GET(u) then return net_problem end

	x = CreateTXQuery(HTTP.Document)
	MANGAINFO.Title     = x.XPathString('//h1[@class="post-title"]/a')
	MANGAINFO.Authors   = x.XPathString('//div[@id="info-i"]/strong[.="Autor:"]/following-sibling::text()[1]')
	MANGAINFO.Genres    = x.XPathStringAll('//div[@id="categ"]/a')
	MANGAINFO.Status    = MangaInfoStatusIfPos(x.XPathString('//span[@class="estado"]'), 'En desarrollo', 'Finalizado')
	MANGAINFO.Summary   = x.XPathString('//div[@id="sinopsis"]')

	for v in x.XPath('//div[@id="c_list"]/a').Get() do
		MANGAINFO.ChapterLinks.Add(v.GetAttribute('href'))
		MANGAINFO.ChapterNames.Add(x.XPathString('div/h3', v))
	end
	MANGAINFO.ChapterLinks.Reverse(); MANGAINFO.ChapterNames.Reverse()

	return no_error
end

-- No image download needed for catalog Update List tests.
function GetPageNumber()
	return true
end
